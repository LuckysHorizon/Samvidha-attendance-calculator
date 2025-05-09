const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const glob = require('glob');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Helper function to find Chrome binary
async function findChromeBinary() {
  const possiblePaths = [
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/render/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
  ];

  for (const chromePath of possiblePaths) {
    if (chromePath && fs.existsSync(chromePath)) {
      return chromePath;
    }
  }

  // If no binary found, let Puppeteer handle it
  return null;
}

// Helper function to login and get browser session
async function loginToSamvidha(username, password) {
  const chromePath = await findChromeBinary();
  console.log('Using Chrome binary at:', chromePath);

  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080'
    ]
  };

  if (chromePath) {
    launchOptions.executablePath = chromePath;
  }

  try {
    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    // Navigate to login page
    await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'networkidle2' });

    // Enter credentials
    await page.type('input[name="txt_uname"]', username);
    await page.type('input[name="txt_pwd"]', password);
    await page.click('button#but_submit');

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Check for login failure
    if (page.url().includes('login')) {
      await browser.close();
      throw new Error('Invalid credentials');
    }

    return { browser, page };
  } catch (error) {
    console.error('Error launching browser:', error);
    throw new Error(`Failed to launch browser: ${error.message}`);
  }
}

app.post('/fetch-attendance', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  let browser;
  try {
    const { browser: b, page } = await loginToSamvidha(username, password);
    browser = b;

    // Navigate to biometric page
    await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'networkidle2' });

    // Scrape detailed attendance data
    const attendanceData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const attendanceDetails = rows.map(row => ({
        date: row.cells[0]?.innerText.trim(),
        day: row.cells[1]?.innerText.trim(),
        inTime: row.cells[2]?.innerText.trim(),
        outTime: row.cells[3]?.innerText.trim(),
        status: row.cells[6]?.innerText.trim().toLowerCase()
      }));

      let totalDays = rows.length;
      let presentDays = attendanceDetails.filter(detail => detail.status === 'present').length;
      let absentDays = totalDays - presentDays;

      return {
        details: attendanceDetails,
        summary: {
          totalDays,
          presentDays,
          absentDays
        }
      };
    });

    // Calculate attendance metrics
    const attendancePercentage = attendanceData.summary.totalDays > 0 
      ? ((attendanceData.summary.presentDays / attendanceData.summary.totalDays) * 100).toFixed(2) 
      : 0;

    let daysNeeded = 0;
    if (attendancePercentage < 75) {
      const requiredPresent = Math.ceil(0.75 * attendanceData.summary.totalDays);
      daysNeeded = requiredPresent - attendanceData.summary.presentDays;
    }

    res.json({
      totalClasses: attendanceData.summary.totalDays,
      present: attendanceData.summary.presentDays,
      absent: attendanceData.summary.absentDays,
      attendancePercentage,
      daysNeeded,
      details: attendanceData.details
    });
  } catch (error) {
    console.error('Error in fetch-attendance:', error.message);
    res.status(500).json({ error: 'Failed to fetch attendance data: ' + error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.post('/fetch-class-attendance', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  let browser;
  try {
    const { browser: b, page } = await loginToSamvidha(username, password);
    browser = b;

    // Navigate to course content page
    await page.goto('https://samvidha.iare.ac.in/home?action=course_content', { waitUntil: 'networkidle2' });
    // Wait for the table or fallback to a longer wait
    try {
      await page.waitForSelector('table.table', { timeout: 10000 });
    } catch (e) {
      await page.waitForTimeout(3000); // fallback wait
    }
    // Scrape attendance data from the table
    const attendanceRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table.table tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        return {
          date: cells[1]?.innerText.trim(),
          period: cells[2]?.innerText.trim(),
          topic: cells[3]?.innerText.trim(),
          status: cells[4]?.innerText.trim().toUpperCase()
        };
      });
    });

    // Aggregate attendance by topic
    const topicMap = {};
    attendanceRows.forEach(row => {
      const topic = row.topic || 'Unknown';
      if (!topicMap[topic]) {
        topicMap[topic] = { topic, total: 0, present: 0, absent: 0 };
      }
      topicMap[topic].total++;
      if (row.status === 'PRESENT') topicMap[topic].present++;
      if (row.status === 'ABSENT') topicMap[topic].absent++;
    });

    const classAttendanceData = Object.values(topicMap).map(topic => ({
      subjectName: topic.topic,
      totalClasses: topic.total,
      classesAttended: topic.present,
      percentage: topic.total > 0 ? ((topic.present / topic.total) * 100).toFixed(2) : 0,
      attendanceInfo: `${topic.present}/${topic.total} classes`,
      absent: topic.absent
    }));

    if (classAttendanceData.length === 0) {
      throw new Error('No attendance data found. Please check if you have access to the course content page.');
    }

    res.json({ classAttendanceData });
  } catch (error) {
    console.error('Error in fetch-class-attendance:', error.message);
    res.status(500).json({ error: 'Failed to fetch class attendance data: ' + error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
