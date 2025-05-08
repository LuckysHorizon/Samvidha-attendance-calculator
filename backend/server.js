const express = require('express');
   const puppeteer = require('puppeteer-core');
   const cors = require('cors');
   const path = require('path');
   require('dotenv').config();

   const app = express();
   const port = process.env.PORT || 3000;

   // Middleware
   app.use(cors());
   app.use(express.json());

   // Serve static files from the 'frontend' folder
   app.use(express.static(path.join(__dirname, '../frontend')));

   // Serve index.html for the root URL
   app.get('/', (req, res) => {
     res.sendFile(path.join(__dirname, '../frontend/index.html'));
   });

   // Helper function to login and get browser session
   async function loginToSamvidha(username, password) {
     console.log('Launching Puppeteer with executable path:', process.env.PUPPETEER_EXECUTABLE_PATH);
     const browser = await puppeteer.launch({
       headless: true,
       executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
       args: [
         '--no-sandbox',
         '--disable-setuid-sandbox',
         '--disable-dev-shm-usage',
         '--disable-accelerated-2d-canvas',
         '--no-first-run',
         '--no-zygote',
         '--disable-gpu'
       ]
     });
     console.log('Browser launched successfully');

     const page = await browser.newPage();

     // Set a user agent to mimic a real browser
     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

     try {
       // Navigate to login page
       console.log('Navigating to login page...');
       await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'networkidle2', timeout: 60000 });

       // Check for network errors or redirects
       const currentUrl = page.url();
       console.log('Current URL after navigation:', currentUrl);
       if (!currentUrl.includes('samvidha.iare.ac.in')) {
         throw new Error('Failed to reach login page. Possible network issue or redirect.');
       }

       // Check if login form exists
       const loginFormExists = await page.$('input[name="txt_uname"]') !== null;
       if (!loginFormExists) {
         await page.screenshot({ path: 'login-page-error.png' });
         throw new Error('Login form not found. The page structure may have changed.');
       }

       // Enter credentials
       console.log('Entering credentials...');
       await page.type('input[name="txt_uname"]', username);
       await page.type('input[name="txt_pwd"]', password);
       await page.click('button#but_submit');

       // Wait for navigation
       console.log('Waiting for navigation after login...');
       await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

       // Check for login failure
       if (page.url().includes('login')) {
         throw new Error('Invalid credentials');
       }

       return { browser, page };
     } catch (error) {
       await browser.close();
       throw error;
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
       console.log('Navigating to biometric page...');
       await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'networkidle2', timeout: 60000 });

       // Check if attendance table exists
       const tableExists = await page.$('table tbody tr') !== null;
       if (!tableExists) {
         await page.screenshot({ path: 'biometric-page-error.png' });
         throw new Error('Attendance table not found. The page structure may have changed.');
       }

       // Scrape detailed attendance data
       console.log('Scraping attendance data...');
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
       console.log('Navigating to course content page...');
       await page.goto('https://samvidha.iare.ac.in/home?action=course_content', { waitUntil: 'networkidle2', timeout: 60000 });

       // Wait for the table or fallback to a longer wait
       console.log('Waiting for attendance table...');
       try {
         await page.waitForSelector('table.table', { timeout: 10000 });
       } catch (e) {
         await page.waitForTimeout(3000); // fallback wait
         const tableExists = await page.$('table.table') !== null;
         if (!tableExists) {
           await page.screenshot({ path: 'course-content-page-error.png' });
           throw new Error('Course attendance table not found. The page structure may have changed.');
         }
       }

       // Scrape attendance data from the table
       console.log('Scraping class attendance data...');
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
