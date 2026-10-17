/**
 * ==============================================================================
 * Google Flow Automated Image Generator
 * ==============================================================================
 * Rock-solid Puppeteer automation script to sequentially generate and download
 * images on Google Flow without crashes, blank pages, or premature stops.
 * Automatically creates a fresh project on every launch and saves downloads into
 * timestamped session folders.
 * Features a multi-layered, bulletproof image extraction engine.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  FLOW_DASHBOARD_URL: 'https://flow.google.com/',
  FLOW_FALLBACK_URL: 'https://labs.google/fx/tools/flow',
  FLOW_URL: 'https://flow.google.com/', // Alias for dashboard URL
  USER_DATA_DIR: path.resolve(__dirname, 'chrome_user_data'),
  PROMPTS_FILE: path.resolve(__dirname, 'prompts.txt'),
  BASE_OUTPUT_DIR: path.resolve(__dirname, 'downloaded_images'),
  OUTPUT_DIR: path.resolve(__dirname, 'downloaded_images'), // Set dynamically to session subfolder in main()
  INPUT_DETECTION_TIMEOUT_MS: 10000,
  USER_CLICK_WAIT_TIMEOUT_MS: 60000,
  NEW_PROJECT_AUTO_TIMEOUT_MS: 12000, // 12 seconds auto-detection before fallback
  GENERATION_TIMEOUT_MS: 180000,      // 3 minutes timeout per prompt
  COOLDOWN_MS: 4000,                  // 4 seconds (within 3-5s requirement)
  TYPING_DELAY_MS: 15,                // Natural typing speed to trigger UI state
  SETUP_PAUSE_SECONDS: 15,            // 15s parameter setup pause
  LOCKIN_BUFFER_SECONDS: 10,          // 10s buffer window to lock in custom UI toggles
};

// Global network response buffer for the active prompt
let promptNetworkImages = [];

// ==========================================
// UTILITY FUNCTIONS
// ==========================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function generateSessionDir(baseOutputDir) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const YYYY = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const DD = pad(now.getDate());
  const HH = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const folderName = `session_${YYYY}-${MM}-${DD}_${HH}-${mm}-${ss}`;
  return path.join(baseOutputDir, folderName);
}

function loadPrompts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompts file not found at: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith('#') || line.startsWith('//')) return false;
      // Skip category section headers like "🎅 Santa & Friends (1-10)"
      if (/\(\d+-\d+\)/.test(line)) return false;
      return true;
    });
}

function getDirectoryFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath);
}

function deleteAnyZipFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const lower = file.toLowerCase();
      if (lower.endsWith('.zip') || (lower.endsWith('.crdownload') && lower.includes('.zip'))) {
        const fullPath = path.join(dirPath, file);
        try {
          fs.unlinkSync(fullPath);
          console.log(`🗑️ Deleted unwanted zip archive immediately: ${file}`);
        } catch (e) {
          console.warn(`⚠️ Could not delete zip archive ${file}: ${e.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ Error checking zip files: ${err.message}`);
  }
}

function startZipWatcher(dirPath) {
  try {
    ensureDirectoryExists(dirPath);
    return fs.watch(dirPath, (eventType, filename) => {
      if (!filename) return;
      const lower = filename.toLowerCase();
      if (lower.endsWith('.zip') || (lower.endsWith('.crdownload') && lower.includes('.zip'))) {
        const fullPath = path.join(dirPath, filename);
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log(`🗑️ [Watcher] Deleted unwanted zip archive immediately: ${filename}`);
          }
        } catch (e) {}
      }
    });
  } catch (err) {
    console.warn(`⚠️ Warning setting up zip watcher: ${err.message}`);
    return null;
  }
}


// ==========================================
// BROWSER INITIALIZATION & CDP CONFIGURATION
// ==========================================
async function configureCdpDownloads(page, downloadPath = CONFIG.OUTPUT_DIR) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath,
    });
    console.log(`📂 Configured CDP native downloads to: ${downloadPath}`);
    return client;
  } catch (err) {
    console.warn(`⚠️ Warning setting CDP download behavior: ${err.message}`);
    return null;
  }
}

function attachNetworkResponseListener(page) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const contentType = (response.headers()['content-type'] || '').toLowerCase();
      if (
        contentType.startsWith('image/') ||
        url.includes('.png') ||
        url.includes('.jpg') ||
        url.includes('.jpeg') ||
        url.includes('.webp') ||
        url.includes('googleusercontent.com')
      ) {
        const buffer = await response.buffer().catch(() => null);
        // Only keep substantial images (> 20KB) to skip tiny icons/avatars
        if (buffer && buffer.length > 20480) {
          promptNetworkImages.push({
            url,
            buffer,
            contentType,
            size: buffer.length,
            time: Date.now(),
          });
        }
      }
    } catch (e) {}
  });
}

async function launchBrowser() {
  console.log('🚀 Launching Chrome with dedicated profile (no blank page)...');
  ensureDirectoryExists(CONFIG.USER_DATA_DIR);
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: CONFIG.USER_DATA_DIR,
    args: [
      '--start-maximized',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Grab the initial page instead of calling browser.newPage()
  const pages = await browser.pages();
  const page = pages[0];

  // Close any extra tabs restored from previous session so we start clean
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }

  // Configure Native Browser Downloads to session OUTPUT_DIR (CDP)
  await configureCdpDownloads(page, CONFIG.OUTPUT_DIR);

  // Attach network response listener for full image payloads
  attachNetworkResponseListener(page);

  // Guard against any subsequent tabs created by Chrome/extensions
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const newPage = await target.page().catch(() => null);
      if (newPage) {
        await configureCdpDownloads(newPage, CONFIG.OUTPUT_DIR);
        attachNetworkResponseListener(newPage);

        if (newPage !== page && (newPage.url() === 'about:blank' || newPage.url() === '')) {
          setTimeout(async () => {
            if (newPage.url() === 'about:blank' || newPage.url() === '') {
              await newPage.close().catch(() => {});
            }
          }, 300);
        }
      }
    }
  });

  return { browser, page };
}

// ==========================================
// NAVIGATION & LOGIN HANDLER
// ==========================================
async function navigateAndHandleLogin(page) {
  console.log(`🌐 Navigating to Google Flow Dashboard: ${CONFIG.FLOW_DASHBOARD_URL}`);
  try {
    await page.goto(CONFIG.FLOW_DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    console.log('⚠️ Primary dashboard URL took long or redirected, attempting fallback...');
    try {
      await page.goto(CONFIG.FLOW_FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log('⚠️ Fallback navigation also delayed, verifying current page state...');
    }
  }

  // Check if redirected to Google sign-in
  let currentUrl = page.url();
  if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
    console.log('\n======================================================================');
    console.log('🔐 GOOGLE LOGIN REQUIRED');
    console.log('👉 Please log into your Google Account in the opened Chrome window.');
    console.log('⏳ Waiting patiently for login to complete and Flow dashboard to load...');
    console.log('======================================================================\n');

    while (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
      await sleep(2000);
    }
    console.log('✅ Google sign-in detected! Waiting for Google Flow dashboard to settle...');
    await sleep(5000);
  }

  // Allow dashboard to hydrate
  console.log('⏳ Waiting for Flow dashboard to stabilize...');
  await sleep(4000);
}

// ==========================================
// AUTOMATIC "NEW PROJECT" CREATION & WORKSPACE SETUP
// ==========================================
async function searchAndClickNewProjectButton(page) {
  try {
    return await page.evaluate(() => {
      function isVisible(el) {
        if (!el) return false;
        try {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0
          );
        } catch (e) {
          return false;
        }
      }

      const candidateList = [];

      function collectElements(root) {
        if (!root) return;

        // Traverse shadow root recursively if present
        if (root.shadowRoot) {
          collectElements(root.shadowRoot);
        }

        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const node of nodes) {
          if (node.shadowRoot) {
            collectElements(node.shadowRoot);
          }

          if (!isVisible(node)) continue;

          const tag = node.tagName.toLowerCase();
          const role = (node.getAttribute('role') || '').toLowerCase();

          // Check if candidate clickable tag, role, or interactive element
          const isClickable =
            tag === 'button' ||
            tag === 'a' ||
            role === 'button' ||
            role === 'link' ||
            role === 'tab' ||
            node.hasAttribute('onclick') ||
            node.getAttribute('tabindex') === '0' ||
            node.classList.contains('button') ||
            node.classList.contains('btn') ||
            tag.includes('button') ||
            tag.includes('card') ||
            tag.includes('tile') ||
            node.getAttribute('data-action') === 'new-project' ||
            node.getAttribute('data-action') === 'create';

          if (!isClickable) continue;

          const ariaLabel = (node.getAttribute('aria-label') || '').trim();
          const title = (node.getAttribute('title') || '').trim();
          const text = (node.innerText || node.textContent || '').trim();
          const href = (node.getAttribute('href') || '').trim();
          const testId = (node.getAttribute('data-testid') || '').trim();
          const id = (node.id || '').trim();

          candidateList.push({
            el: node,
            text,
            ariaLabel,
            title,
            href,
            testId,
            id,
          });
        }
      }

      collectElements(document.body || document.documentElement);

      function scoreCandidate(item) {
        const textClean = item.text.replace(/\s+/g, ' ').trim();
        const ariaClean = item.ariaLabel.replace(/\s+/g, ' ').trim();
        const titleClean = item.title.replace(/\s+/g, ' ').trim();
        const combined = `${textClean} ${ariaClean} ${titleClean}`.toLowerCase();

        // Negative filters: ignore unrelated elements
        if (
          combined.includes("what's new") ||
          combined.includes('news') ||
          combined.includes('privacy') ||
          combined.includes('terms') ||
          combined.includes('sign out') ||
          combined.includes('delete') ||
          combined.includes('help')
        ) {
          return 0;
        }

        // Priority 1: Clear text or aria-label containing "New Project" / "Create Project"
        if (
          /(\b|\+)new\s+project\b/i.test(textClean) ||
          /(\b|\+)new\s+project\b/i.test(ariaClean) ||
          /(\b|\+)create\s+project\b/i.test(textClean) ||
          /(\b|\+)create\s+project\b/i.test(ariaClean) ||
          /nouveau\s+projet/i.test(combined)
        ) {
          return 100;
        }

        // Priority 2: Direct href pointing to new/create project
        if (item.href && (/project\/(new|create)/i.test(item.href) || /new-project/i.test(item.href))) {
          return 90;
        }

        // Priority 3: Exact or primary text/aria-label matches "New", "Create", "+", "Start"
        const lowerT = textClean.toLowerCase();
        const lowerA = ariaClean.toLowerCase();
        if (
          /^(\+?\s*new|\+?\s*create|\+?\s*start|\+)$/i.test(lowerT) ||
          /^(\+?\s*new|\+?\s*create|\+?\s*start|\+)$/i.test(lowerA)
        ) {
          return 85;
        }

        // Priority 4: testId or id explicitly indicates new project
        if (
          /new-project|create-project|add-project/i.test(item.testId) ||
          /new-project|create-project|add-project/i.test(item.id)
        ) {
          return 80;
        }

        // Priority 5: Button containing plus/add SVG/icon combined with create/new/project
        const icon = item.el.querySelector('svg, mat-icon, i');
        if (icon) {
          const iconText = (icon.innerText || icon.getAttribute('data-icon') || icon.getAttribute('aria-label') || '').toLowerCase();
          if (iconText.includes('add') || iconText.includes('plus') || iconText.includes('create')) {
            return 75;
          }
        }

        // Priority 6: Matches standalone "create" or "start"
        if (
          /\bcreate\b/i.test(lowerT) ||
          /\bcreate\b/i.test(lowerA) ||
          /\bstart\b/i.test(lowerT) ||
          /\bstart\b/i.test(lowerA)
        ) {
          return 60;
        }

        return 0;
      }

      let bestCandidate = null;
      let highestScore = 0;

      for (const cand of candidateList) {
        const score = scoreCandidate(cand);
        if (score > highestScore) {
          highestScore = score;
          bestCandidate = cand;
        }
      }

      if (bestCandidate && highestScore > 0) {
        const el = bestCandidate.el;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();

        return {
          clicked: true,
          label: bestCandidate.text || bestCandidate.ariaLabel || bestCandidate.title || 'New Project button',
          score: highestScore,
        };
      }

      return { clicked: false };
    });
  } catch (err) {
    return { clicked: false, error: err.message };
  }
}

async function waitForWorkspaceReady(page) {
  console.log('⏳ Waiting for Google Flow workspace to load and hydrate...');
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  } catch (e) {}

  await sleep(4000);
  await page.bringToFront().catch(() => {});
  await configureCdpDownloads(page, CONFIG.OUTPUT_DIR);
  attachNetworkResponseListener(page);
  console.log(`✅ Fresh workspace ready at: ${page.url()}\n`);
}

async function createNewProject(browser, initialPage) {
  let page = initialPage;
  const initialUrl = page.url();

  console.log('\n======================================================================');
  console.log('🆕 CREATING A BRAND NEW PROJECT WORKSPACE');
  console.log('🔍 Searching DOM (including shadow DOMs) for "New Project" / "Create" button...');
  console.log('======================================================================\n');

  // Helper to locate active project page
  const checkProjectUrl = async () => {
    const pages = await browser.pages();
    for (const p of pages) {
      const u = p.url();
      if (u.includes('/project/')) {
        // If initialUrl already contained /project/, ensure URL changed to a different project
        if (initialUrl.includes('/project/') && u === initialUrl) {
          continue;
        }
        return p;
      }
    }
    return null;
  };

  // 1. Automatic detection & click within 12 seconds
  const autoDetectStart = Date.now();
  let clickedButton = false;

  while (Date.now() - autoDetectStart < CONFIG.NEW_PROJECT_AUTO_TIMEOUT_MS) {
    // Check if browser URL already transitioned to a new project
    const projectPage = await checkProjectUrl();
    if (projectPage) {
      page = projectPage;
      console.log(`🎯 New project URL reached: ${page.url()}`);
      await waitForWorkspaceReady(page);
      return page;
    }

    if (!clickedButton) {
      const clickResult = await searchAndClickNewProjectButton(page);
      if (clickResult && clickResult.clicked) {
        console.log(`🖱️ Automatically clicked "${clickResult.label}" button!`);
        console.log('⏳ Waiting for browser URL to change to newly generated /project/... URL...');
        clickedButton = true;
      }
    }

    await sleep(600);
  }

  // Final check before triggering interactive fallback
  const finalAutoCheck = await checkProjectUrl();
  if (finalAutoCheck) {
    page = finalAutoCheck;
    console.log(`🎯 New project URL reached: ${page.url()}`);
    await waitForWorkspaceReady(page);
    return page;
  }

  // 2. Interactive Fallback: If not detected within 12 seconds
  console.log('\n======================================================================');
  console.log('👉 Please click "New Project" in the browser to open a fresh workspace...');
  console.log('⏳ Waiting until browser URL contains "/project/" to continue...');
  console.log('======================================================================\n');

  while (true) {
    const projectPage = await checkProjectUrl();
    if (projectPage) {
      page = projectPage;
      console.log(`\n🎉 New project workspace detected: ${page.url()}`);
      break;
    }
    await sleep(800);
  }

  await waitForWorkspaceReady(page);
  return page;
}

// ==========================================
// INPUT BOX LOCATOR & INTERACTIVE FALLBACK
// ==========================================
const CANDIDATE_SELECTORS = [
  '[data-puppeteer-prompt-input="true"]',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[role="textbox"]',
  'div[data-placeholder]',
  'input[type="text"]:not([disabled])',
];

async function findPromptInput(page) {
  // 1. Try automatic detection for up to 10 seconds
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.INPUT_DETECTION_TIMEOUT_MS) {
    for (const selector of CANDIDATE_SELECTORS) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const isVisible = await page
            .evaluate((node) => {
              if (!node) return false;
              const style = window.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 30 &&
                rect.height > 15
              );
            }, el)
            .catch(() => false);

          if (isVisible) {
            // Tag this element so subsequent queries can find it easily
            await page
              .evaluate((node) => {
                node.setAttribute('data-puppeteer-prompt-input', 'true');
              }, el)
              .catch(() => {});
            return el;
          }
        }
      } catch (selErr) {
        continue;
      }
    }
    await sleep(500);
  }

  // 2. Fallback: Ask user to click inside the prompt input box
  console.log('\n======================================================================');
  console.log('👉 Please click inside the prompt input box in the browser...');
  console.log('⏳ Polling activeElement for your click (up to 60s)...');
  console.log('======================================================================\n');

  const waitStart = Date.now();
  while (Date.now() - waitStart < CONFIG.USER_CLICK_WAIT_TIMEOUT_MS) {
    const detected = await page
      .evaluate(() => {
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          active !== document.documentElement &&
          (active.tagName === 'TEXTAREA' ||
            active.tagName === 'INPUT' ||
            active.isContentEditable ||
            active.getAttribute('role') === 'textbox' ||
            active.getAttribute('contenteditable') === 'true')
        ) {
          active.setAttribute('data-puppeteer-prompt-input', 'true');
          return {
            tagName: active.tagName.toLowerCase(),
            id: active.id || '',
            className: active.className || '',
          };
        }
        return null;
      })
      .catch(() => null);

    if (detected) {
      console.log(`🎯 Input element focused by user (<${detected.tagName}>)! Resuming automation...`);
      const handle = await page.$('[data-puppeteer-prompt-input="true"]');
      if (handle) return handle;
    }

    await sleep(1000);
  }

  console.warn('⚠️ No input box detected within 60s. Continuing search on next step...');
  return null;
}

// ==========================================
// AUTOMATIC GENERATION PARAMETERS SETUP
// ==========================================
async function configureFlowParameters(page) {
  console.log('\n======================================================================');
  console.log('⚙️  AUTOMATIC GENERATION PARAMETERS SETUP');
  console.log('🔍 Scanning UI toolbar for aspect ratio (3:4 or 1:1) and image count (x3 / 3)...');
  console.log(`👉 ${CONFIG.SETUP_PAUSE_SECONDS}-second setup window active to verify & adjust workspace parameters.`);
  console.log('======================================================================\n');

  const attemptParameterSelection = async () => {
    return await page
      .evaluate(() => {
        const results = {
          aspectRatioSet: null,
          batchSizeSet: null,
        };

        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const isSelected = (el) => {
          return (
            el.getAttribute('aria-selected') === 'true' ||
            el.getAttribute('aria-checked') === 'true' ||
            el.getAttribute('aria-pressed') === 'true' ||
            el.classList.contains('selected') ||
            el.classList.contains('active') ||
            el.classList.contains('checked')
          );
        };

        const clickElement = (el) => {
          el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
          el.click();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        };

        const allElements = Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="radio"], [role="option"], [role="tab"], div[tabindex="0"], chip, mat-chip'
          )
        ).filter(isVisible);

        // --- 1. ASPECT RATIO (Prefer 3:4, fallback 1:1) ---
        let aspect34 = allElements.find((el) => {
          const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
          return /^3:4$/i.test(text) || /\b3:4\b/i.test(text) || /portrait\s*3:4/i.test(text);
        });

        if (aspect34) {
          if (isSelected(aspect34)) {
            results.aspectRatioSet = '3:4 (already active)';
          } else {
            clickElement(aspect34);
            results.aspectRatioSet = '3:4 (selected)';
          }
        } else {
          let aspect11 = allElements.find((el) => {
            const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
            return /^1:1$/i.test(text) || /\b1:1\b/i.test(text) || /square\s*1:1/i.test(text);
          });
          if (aspect11) {
            if (isSelected(aspect11)) {
              results.aspectRatioSet = '1:1 (already active)';
            } else {
              clickElement(aspect11);
              results.aspectRatioSet = '1:1 (selected)';
            }
          }
        }

        // If aspect ratio is behind a dropdown/menu:
        if (!results.aspectRatioSet) {
          const aspectDropdown = allElements.find((el) => {
            const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().toLowerCase();
            return text.includes('aspect') || text.includes('ratio');
          });
          if (aspectDropdown && !aspectDropdown.hasAttribute('data-opened-by-bot')) {
            aspectDropdown.setAttribute('data-opened-by-bot', 'true');
            clickElement(aspectDropdown);
          }
        }

        // --- 2. IMAGE COUNT / BATCH SIZE (Target: x3 or 3) ---
        let batch3 = allElements.find((el) => {
          const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
          return /^x?3$/i.test(text) || /^3\s*images?$/i.test(text) || /batch.*3/i.test(text) || text === '3';
        });

        if (batch3) {
          if (isSelected(batch3)) {
            results.batchSizeSet = '3 images (already active)';
          } else {
            clickElement(batch3);
            results.batchSizeSet = '3 images (selected)';
          }
        } else {
          const batchDropdown = allElements.find((el) => {
            const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().toLowerCase();
            return text.includes('count') || text.includes('batch') || text.includes('images');
          });
          if (batchDropdown && !batchDropdown.hasAttribute('data-opened-by-bot')) {
            batchDropdown.setAttribute('data-opened-by-bot', 'true');
            clickElement(batchDropdown);
          }
        }

        return results;
      })
      .catch(() => ({ aspectRatioSet: null, batchSizeSet: null }));
  };

  // Run initial scan
  const initialResult = await attemptParameterSelection();
  if (initialResult.aspectRatioSet) console.log(`   🎯 Aspect Ratio: ${initialResult.aspectRatioSet}`);
  if (initialResult.batchSizeSet) console.log(`   🎯 Batch Size: ${initialResult.batchSizeSet}`);

  // Setup pause with terminal countdown
  for (let s = CONFIG.SETUP_PAUSE_SECONDS; s > 0; s--) {
    if (s === 10 || s === 5) {
      const midResult = await attemptParameterSelection();
      if (midResult.aspectRatioSet && !initialResult.aspectRatioSet) {
        console.log(`\n   🎯 Aspect Ratio: ${midResult.aspectRatioSet}`);
      }
      if (midResult.batchSizeSet && !initialResult.batchSizeSet) {
        console.log(`\n   🎯 Batch Size: ${midResult.batchSizeSet}`);
      }
    }
    process.stdout.write(`\r⏳ Setup countdown: ${s}s remaining (review parameters in Chrome)... `);
    await sleep(1000);
  }
  process.stdout.write('\r✅ Generation parameters configuration step complete!                    \n\n');
}

// 10-second buffer right after finding prompt box to lock in toggles
async function waitForWorkspaceLockin(seconds = CONFIG.LOCKIN_BUFFER_SECONDS) {
  console.log('======================================================================');
  console.log('🔒 LOCKING IN WORKSPACE SETTINGS');
  console.log(`⏳ Allowing a ${seconds}-second window for custom UI toggles to stay locked in...`);
  console.log('======================================================================');
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`\r⏳ Session lock-in: ${s}s remaining before queue starts... `);
    await sleep(1000);
  }
  process.stdout.write('\r✅ UI toggles locked in for the entire session! Starting queue now...  \n\n');
}

// ==========================================
// HARD CLEAR INPUT
// ==========================================
async function hardClearInput(page, inputElement) {
  if (!inputElement) return;

  try {
    // Focus the element
    await inputElement.focus();
    await sleep(100);

    // Ctrl+A -> Backspace
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await sleep(50);
    await page.keyboard.press('Backspace');
    await sleep(50);

    // DOM-level hard wipe and dispatch input/change events to notify reactive frameworks
    await page
      .evaluate((el) => {
        if (!el) return;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          el.value = '';
        } else {
          el.innerText = '';
          el.innerHTML = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inputElement)
      .catch(() => {});

    await sleep(100);
  } catch (err) {
    console.warn(`⚠️ Warning while clearing input: ${err.message}`);
  }
}

// ==========================================
// TYPE & 100% AUTOMATIC PROMPT SUBMISSION
// ==========================================
async function typeAndTriggerPrompt(page, inputElement, promptText) {
  // 1. Ensure the prompt input element is actively focused
  await inputElement.focus();
  await sleep(100);

  // Type the prompt cleanly
  await page.keyboard.type(promptText, { delay: CONFIG.TYPING_DELAY_MS });
  await sleep(200);

  // Dispatch input & change events
  await page
    .evaluate((el) => {
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputElement)
    .catch(() => {});
  await sleep(200);

  // Re-ensure active focus right before pressing Enter
  await inputElement.focus();
  await sleep(100);

  // 2. Dispatch Enter keyboard events directly on the input element
  console.log('⌨️  Triggering Enter events directly on prompt input...');
  await page
    .evaluate((el) => {
      if (!el) return;
      el.focus();
      const eventInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    }, inputElement)
    .catch(() => {});

  await page.keyboard.press('Enter');

  // 3. Button Click Fallback: Verify within 1.5 seconds if prompt was submitted
  console.log('⏳ Verifying submission state (1.5s check)...');
  await sleep(1500);

  const checkStatus = await page
    .evaluate((el) => {
      if (!el) return { textRemaining: false, isBusy: true };
      const text =
        el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
          ? el.value
          : el.innerText || el.textContent || '';

      const isBusy =
        !!document.querySelector(
          '[aria-busy="true"], .generating, .loading, [data-state="generating"], mat-progress-bar, mat-spinner'
        ) || /generating\.\.\.|creating\.\.\.|thinking\.\.\./i.test(document.body ? document.body.innerText : '');

      return {
        textRemaining: text.trim().length > 0,
        isBusy,
      };
    }, inputElement)
    .catch(() => ({ textRemaining: false, isBusy: false }));

  if (!checkStatus.textRemaining || checkStatus.isBusy) {
    console.log('🚀 Generation triggered successfully via Enter key!');
    return;
  }

  // Fallback: If text is still sitting in the input box or generation hasn't started
  console.log('⚡ Prompt text still in input. Activating Submit Button Click Fallback...');
  const buttonClicked = await page
    .evaluate((inputEl) => {
      const isClickable = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0 &&
          !el.disabled &&
          el.getAttribute('aria-disabled') !== 'true'
        );
      };

      const triggerClick = (btn) => {
        btn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.click();
      };

      // A. Search inside prompt bar container / adjacent toolbar
      let parent = inputEl ? inputEl.parentElement : null;
      let targetButton = null;

      for (let depth = 0; depth < 6 && parent; depth++) {
        const candidates = Array.from(
          parent.querySelectorAll('button, [role="button"], div[tabindex="0"]')
        ).filter(isClickable);

        targetButton = candidates.find((b) => {
          const label = (b.innerText || b.getAttribute('aria-label') || b.title || '').trim().toLowerCase();
          return (
            /^(generate|create|run|submit|send|arrow_upward|arrow_forward)$/i.test(label) ||
            label.includes('generate') ||
            label.includes('send') ||
            label.includes('submit') ||
            label.includes('run') ||
            label.includes('arrow')
          );
        });

        if (!targetButton) {
          targetButton = candidates.find((b) => {
            const svg = b.querySelector('svg, mat-icon, i');
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            return svg && !/clear|close|delete|cancel|attach|help/i.test(label);
          });
        }

        if (targetButton) break;
        parent = parent.parentElement;
      }

      // B. Global search if container traversal didn't locate it
      if (!targetButton) {
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isClickable);
        targetButton = allButtons.find((b) => {
          const label = (b.innerText || b.getAttribute('aria-label') || b.title || '').trim().toLowerCase();
          return (
            /^(generate|create|run|submit|send)$/i.test(label) ||
            /generate prompt|run prompt|send prompt|submit prompt/i.test(label)
          );
        });
      }

      if (targetButton) {
        triggerClick(targetButton);
        return {
          clicked: true,
          label: targetButton.getAttribute('aria-label') || targetButton.innerText || 'Submit/Send Button',
        };
      }

      return { clicked: false };
    }, inputElement)
    .catch(() => ({ clicked: false }));

  if (buttonClicked.clicked) {
    console.log(`🎯 Successfully clicked submit button: "${buttonClicked.label}"`);
  } else {
    console.warn('⚠️ Dedicated submit button not found, re-focusing and sending Enter...');
    await inputElement.focus();
    await page.keyboard.press('Enter');
  }

  await sleep(1000);
}

// ==========================================
// PRE-PROMPT SNAPSHOT & DEEP DOM SCANNER
// ==========================================

/**
 * Recursively retrieves all elements in the document and open shadow roots.
 */
function getDomTraversalScript() {
  return `
    function getAllElements(root = document.body || document.documentElement) {
      const elements = [];
      function recurse(node) {
        if (!node) return;
        elements.push(node);
        if (node.shadowRoot) {
          recurse(node.shadowRoot);
        }
        const children = node.children || node.childNodes || [];
        for (const child of children) {
          if (child.nodeType === 1) {
            recurse(child);
          }
        }
      }
      recurse(root);
      return elements;
    }
  `;
}

/**
 * Scans the entire DOM (including open shadowRoots) and records a Set of unique signatures
 * (src URLs, dimensions, element references) for EVERY existing <img> and <canvas> currently on the page.
 */
async function snapshotDOMImageSignatures(page) {
  try {
    return await page.evaluate(() => {
      const signatures = [];

      function getAllElements(root = document.body || document.documentElement) {
        const elements = [];
        function recurse(node) {
          if (!node) return;
          elements.push(node);
          if (node.shadowRoot) {
            recurse(node.shadowRoot);
          }
          const children = node.children || node.childNodes || [];
          for (const child of children) {
            if (child.nodeType === 1) {
              recurse(child);
            }
          }
        }
        recurse(root);
        return elements;
      }

      const allNodes = getAllElements();
      for (const el of allNodes) {
        if (el.tagName === 'IMG') {
          const src = el.currentSrc || el.src;
          if (src) {
            signatures.push(src);
            const w = el.naturalWidth || 0;
            const h = el.naturalHeight || 0;
            signatures.push(`${src}#${w}x${h}`);
            const clean = src.split('?')[0];
            if (clean && clean !== src) {
              signatures.push(clean);
            }
          }
          if (el.id) signatures.push(`img_id:${el.id}`);
        } else if (el.tagName === 'CANVAS') {
          const w = el.width || 0;
          const h = el.height || 0;
          signatures.push(`canvas_${w}x${h}_${el.id || ''}`);
          try {
            const snippet = el.toDataURL('image/png').slice(0, 150);
            if (snippet) signatures.push(`canvas_data:${snippet}`);
          } catch (e) {}
        }
      }

      return signatures;
    });
  } catch (err) {
    console.warn(`⚠️ Warning taking pre-prompt DOM snapshot: ${err.message}`);
    return [];
  }
}

// ==========================================
// WAIT SPECIFICALLY FOR THE 3 NEW IMAGES
// ==========================================
async function waitForNewImagesOfPrompt(page, knownImagesBeforePrompt, timeoutMs = CONFIG.GENERATION_TIMEOUT_MS) {
  const startTime = Date.now();
  console.log(`⏳ Waiting specifically for the 3 new images of current prompt (timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  // Wait 3.5 seconds for UI state to transition into generating
  await sleep(3500);

  const knownArray = Array.from(knownImagesBeforePrompt);
  let pollCount = 0;
  let consecutiveReadyChecks = 0;

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

    const check = await page
      .evaluate((knownList) => {
        const knownSet = new Set(knownList);

        function getAllElements(root = document.body || document.documentElement) {
          const elements = [];
          function recurse(node) {
            if (!node) return;
            elements.push(node);
            if (node.shadowRoot) {
              recurse(node.shadowRoot);
            }
            const children = node.children || node.childNodes || [];
            for (const child of children) {
              if (child.nodeType === 1) {
                recurse(child);
              }
            }
          }
          recurse(root);
          return elements;
        }

        const allNodes = getAllElements();

        // 1. Check if generation / loading is active
        let isBusy = false;
        for (const el of allNodes) {
          if (
            el.getAttribute &&
            (el.getAttribute('aria-busy') === 'true' ||
              el.getAttribute('data-state') === 'generating' ||
              el.classList.contains('generating') ||
              el.classList.contains('loading') ||
              el.classList.contains('spinner') ||
              el.tagName === 'MAT-PROGRESS-BAR' ||
              el.tagName === 'MAT-SPINNER' ||
              el.getAttribute('role') === 'progressbar')
          ) {
            isBusy = true;
            break;
          }
        }

        if (!isBusy) {
          const bodyText = (document.body ? document.body.innerText : '') || '';
          if (/generating\.\.\.|creating\.\.\.|thinking\.\.\./i.test(bodyText)) {
            isBusy = true;
          }
        }

        // 2. Scan for brand new large images (naturalWidth >= 256, naturalHeight >= 256, complete === true)
        const newImages = [];
        for (const el of allNodes) {
          if (el.tagName === 'IMG') {
            if (!el.complete) continue;
            const nw = el.naturalWidth || 0;
            const nh = el.naturalHeight || 0;
            // Ignore tiny avatars, icons, or sidebar thumbnails (width < 256)
            if (nw < 256 || nh < 256) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 100) continue;

            const src = el.currentSrc || el.src || '';
            if (!src) continue;

            // Must NOT be in knownImagesBeforePrompt
            if (knownSet.has(src)) continue;
            if (knownSet.has(`${src}#${nw}x${nh}`)) continue;
            const clean = src.split('?')[0];
            if (clean && knownSet.has(clean)) continue;
            if (el.id && knownSet.has(`img_id:${el.id}`)) continue;

            newImages.push({
              type: 'img',
              src,
              width: nw,
              height: nh,
            });
          } else if (el.tagName === 'CANVAS') {
            const w = el.width || 0;
            const h = el.height || 0;
            if (w < 256 || h < 256) continue;

            const sig = `canvas_${w}x${h}_${el.id || ''}`;
            if (knownSet.has(sig)) continue;

            let dataSnippet = '';
            try {
              dataSnippet = el.toDataURL('image/png').slice(0, 150);
              if (dataSnippet && knownSet.has(`canvas_data:${dataSnippet}`)) continue;
            } catch (e) {}

            newImages.push({
              type: 'canvas',
              src: dataSnippet,
              width: w,
              height: h,
            });
          }
        }

        return {
          isBusy,
          newImageCount: newImages.length,
          samples: newImages.slice(0, 3).map((item) => `${item.type}:${item.width}x${item.height}`),
        };
      }, knownArray)
      .catch(() => ({ isBusy: true, newImageCount: 0, samples: [] }));

    if (pollCount % 4 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `   ⏳ Polling: ${elapsed}s elapsed | New large images: ${check.newImageCount}/3 | UI busy: ${check.isBusy}`
      );
    }

    // Condition: At least 3 brand new large images appear AND loading state finishes
    if (check.newImageCount >= 3 && !check.isBusy) {
      consecutiveReadyChecks++;
      if (consecutiveReadyChecks >= 2) {
        console.log(`🎯 3 brand new large images detected and loading finished!`);
        console.log(`⏳ Waiting an extra 2.5s for high-resolution textures to finish rendering completely...`);
        await sleep(2500);
        return true;
      }
    } else {
      consecutiveReadyChecks = 0;
    }

    // Edge-case stability fallback: 3 new images arrived and stayed stable for multiple polls
    if (check.newImageCount >= 3 && pollCount >= 10) {
      console.log(`🎯 3 brand new large images detected and stable in DOM!`);
      console.log(`⏳ Waiting an extra 2.5s for high-resolution textures to finish rendering completely...`);
      await sleep(2500);
      return true;
    }

    await sleep(1200);
  }

  console.warn('⚠️ Generation timeout reached. Proceeding with image extraction...');
  return false;
}

// ==========================================
// DIRECT INDIVIDUAL PNG EXTRACTION (ALL 3 IMAGES, NO ZIP)
// ==========================================
async function extractAndSaveNewImages(page, knownImagesBeforePrompt, promptNumber) {
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);
  deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

  const paddedIndex = String(promptNumber).padStart(2, '0');
  const savedFiles = [];
  const knownArray = Array.from(knownImagesBeforePrompt);

  console.log(`🔍 [PNG Extraction] Identifying 3 new generated images for Prompt #${promptNumber}...`);

  // Step 1: Tag the 3 target newly generated images in the DOM
  const tagResult = await page
    .evaluate((knownList) => {
      const knownSet = new Set(knownList);

      function getAllElements(root = document.body || document.documentElement) {
        const elements = [];
        function recurse(node) {
          if (!node) return;
          elements.push(node);
          if (node.shadowRoot) {
            recurse(node.shadowRoot);
          }
          const children = node.children || node.childNodes || [];
          for (const child of children) {
            if (child.nodeType === 1) {
              recurse(child);
            }
          }
        }
        recurse(root);
        return elements;
      }

      const allNodes = getAllElements();

      // Clear any prior tags
      for (const el of allNodes) {
        if (el.hasAttribute && el.hasAttribute('data-flow-new-image-index')) {
          el.removeAttribute('data-flow-new-image-index');
        }
      }

      const candidates = [];

      for (const el of allNodes) {
        if (el.tagName === 'IMG') {
          if (!el.complete) continue;
          const nw = el.naturalWidth || 0;
          const nh = el.naturalHeight || 0;
          if (nw < 256 || nh < 256) continue;

          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 100) continue;

          const src = el.currentSrc || el.src || '';
          if (!src) continue;

          if (knownSet.has(src)) continue;
          if (knownSet.has(`${src}#${nw}x${nh}`)) continue;
          const clean = src.split('?')[0];
          if (clean && knownSet.has(clean)) continue;
          if (el.id && knownSet.has(`img_id:${el.id}`)) continue;

          candidates.push({
            el,
            src,
            width: nw,
            height: nh,
            area: nw * nh,
          });
        } else if (el.tagName === 'CANVAS') {
          const w = el.width || 0;
          const h = el.height || 0;
          if (w < 256 || h < 256) continue;

          const sig = `canvas_${w}x${h}_${el.id || ''}`;
          if (knownSet.has(sig)) continue;

          let dataSnippet = '';
          try {
            dataSnippet = el.toDataURL('image/png').slice(0, 150);
            if (dataSnippet && knownSet.has(`canvas_data:${dataSnippet}`)) continue;
          } catch (e) {}

          candidates.push({
            el,
            src: dataSnippet,
            width: w,
            height: h,
            area: w * h,
          });
        }
      }

      // Take up to the 3 newly generated images (the latest batch in DOM order)
      const targetBatch = candidates.slice(-3);

      targetBatch.forEach((item, idx) => {
        item.el.setAttribute('data-flow-new-image-index', String(idx));
      });

      return targetBatch.map((item, idx) => ({
        index: idx,
        src: item.src,
        width: item.width,
        height: item.height,
      }));
    }, knownArray)
    .catch((err) => {
      console.warn(`⚠️ Error identifying new images: ${err.message}`);
      return [];
    });

  if (!tagResult || tagResult.length === 0) {
    console.warn(`⚠️ No new images detected that pass the pre-prompt diff filter.`);
    return [];
  }

  console.log(`🖼️ Tagged ${tagResult.length} new image(s) for direct PNG extraction.`);

  // Step 2: Extract each of the 3 newly generated images directly as individual PNG files
  for (let idx = 0; idx < tagResult.length; idx++) {
    const imgIndex = idx + 1; // 1, 2, 3
    const filename = `prompt_${paddedIndex}_img_${imgIndex}.png`;
    const filePath = path.join(CONFIG.OUTPUT_DIR, filename);

    console.log(`\n📦 Extracting image ${imgIndex}/${tagResult.length} -> ${filename}...`);

    let saved = false;

    // --- 1. Direct browser-context extraction onto offscreen canvas ---
    try {
      const canvasResult = await page.evaluate(async (targetIdx) => {
        function findTagged(root = document.body || document.documentElement, index) {
          if (!root) return null;
          if (root.querySelector) {
            const el = root.querySelector(`[data-flow-new-image-index="${index}"]`);
            if (el) return el;
          }
          if (root.shadowRoot) {
            const found = findTagged(root.shadowRoot, index);
            if (found) return found;
          }
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const child of all) {
            if (child.shadowRoot) {
              const found = findTagged(child.shadowRoot, index);
              if (found) return found;
            }
          }
          return null;
        }

        const el = findTagged(document.body || document.documentElement, targetIdx);
        if (!el) return { success: false, reason: 'not_found' };

        try {
          const canvas = document.createElement('canvas');
          let w = el.naturalWidth || el.width;
          let h = el.naturalHeight || el.height;
          if (!w || !h) {
            const rect = el.getBoundingClientRect();
            w = Math.round(rect.width);
            h = Math.round(rect.height);
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(el, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/png')) {
            return {
              success: true,
              dataUrl,
              src: el.currentSrc || el.src || '',
              width: w,
              height: h,
            };
          }
        } catch (canvasErr) {
          return { success: false, reason: 'canvas_tainted', error: canvasErr.message };
        }

        return { success: false, reason: 'canvas_failed' };
      }, idx);

      if (canvasResult && canvasResult.success && canvasResult.dataUrl) {
        const base64Data = canvasResult.dataUrl.split(',')[1];
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        const displayPath = path.relative(process.cwd(), filePath);
        console.log(`💾 Saved via Offscreen Canvas: ${displayPath} (${canvasResult.width}x${canvasResult.height})`);
        savedFiles.push(filePath);
        saved = true;

        if (canvasResult.src) {
          knownImagesBeforePrompt.add(canvasResult.src);
          knownImagesBeforePrompt.add(`${canvasResult.src}#${canvasResult.width}x${canvasResult.height}`);
        }
      } else {
        console.log(`   ℹ️ Canvas extraction blocked by CORS (${canvasResult?.reason || 'failed'}). Falling back to fetch...`);
      }
    } catch (e) {
      console.log(`   ⚠️ Canvas extraction error: ${e.message}`);
    }

    // --- 2. In-Browser fetch(img.src) converted via FileReader ---
    if (!saved) {
      try {
        const fetchResult = await page.evaluate(async (targetIdx) => {
          function findTagged(root = document.body || document.documentElement, index) {
            if (!root) return null;
            if (root.querySelector) {
              const el = root.querySelector(`[data-flow-new-image-index="${index}"]`);
              if (el) return el;
            }
            if (root.shadowRoot) {
              const found = findTagged(root.shadowRoot, index);
              if (found) return found;
            }
            const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const child of all) {
              if (child.shadowRoot) {
                const found = findTagged(child.shadowRoot, index);
                if (found) return found;
              }
            }
            return null;
          }

          const el = findTagged(document.body || document.documentElement, targetIdx);
          if (!el) return { success: false, reason: 'not_found' };

          const src = el.currentSrc || el.src;
          if (!src) return { success: false, reason: 'no_src' };

          try {
            const res = await fetch(src, { credentials: 'include' });
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });

            if (dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
              return {
                success: true,
                dataUrl,
                src,
                width: el.naturalWidth || el.width,
                height: el.naturalHeight || el.height,
              };
            }
          } catch (fetchErr) {
            return { success: false, reason: 'fetch_failed', error: fetchErr.message };
          }

          return { success: false, reason: 'fetch_invalid_data' };
        }, idx);

        if (fetchResult && fetchResult.success && fetchResult.dataUrl) {
          const base64Data = fetchResult.dataUrl.split(',')[1];
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
          const displayPath = path.relative(process.cwd(), filePath);
          console.log(`💾 Saved via Browser Fetch: ${displayPath}`);
          savedFiles.push(filePath);
          saved = true;

          if (fetchResult.src) {
            knownImagesBeforePrompt.add(fetchResult.src);
            knownImagesBeforePrompt.add(`${fetchResult.src}#${fetchResult.width}x${fetchResult.height}`);
          }
        } else {
          console.log(`   ℹ️ Fetch fallback unavailable (${fetchResult?.reason || 'failed'}). Falling back to element screenshot...`);
        }
      } catch (e) {
        console.log(`   ⚠️ Fetch extraction error: ${e.message}`);
      }
    }

    // --- 3. Puppeteer Direct Element Screenshot (CORS-immune fallback) ---
    if (!saved) {
      try {
        const handle = await page.evaluateHandle((targetIdx) => {
          function findTagged(root = document.body || document.documentElement, index) {
            if (!root) return null;
            if (root.querySelector) {
              const el = root.querySelector(`[data-flow-new-image-index="${index}"]`);
              if (el) return el;
            }
            if (root.shadowRoot) {
              const found = findTagged(root.shadowRoot, index);
              if (found) return found;
            }
            const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const child of all) {
              if (child.shadowRoot) {
                const found = findTagged(child.shadowRoot, index);
                if (found) return found;
              }
            }
            return null;
          }
          return findTagged(document.body || document.documentElement, targetIdx);
        }, idx);

        const element = handle ? handle.asElement() : null;
        if (element) {
          await element.scrollIntoView().catch(() => {});
          await sleep(150);
          await element.screenshot({ path: filePath, type: 'png' });
          const displayPath = path.relative(process.cwd(), filePath);
          console.log(`💾 Saved via Element Screenshot: ${displayPath}`);
          savedFiles.push(filePath);
          saved = true;
        } else {
          console.error(`❌ Could not locate element handle for image ${imgIndex}`);
        }
      } catch (e) {
        console.error(`❌ Screenshot fallback error for image ${imgIndex}: ${e.message}`);
      }
    }

    // Add metadata signatures to knownImagesBeforePrompt so future prompts ignore them
    const itemMeta = tagResult[idx];
    if (itemMeta && itemMeta.src) {
      knownImagesBeforePrompt.add(itemMeta.src);
      knownImagesBeforePrompt.add(`${itemMeta.src}#${itemMeta.width}x${itemMeta.height}`);
      const clean = itemMeta.src.split('?')[0];
      if (clean) knownImagesBeforePrompt.add(clean);
    }
  }

  // Cleanup DOM tagging attributes
  await page
    .evaluate(() => {
      function getAllElements(root = document.body || document.documentElement) {
        const elements = [];
        function recurse(node) {
          if (!node) return;
          elements.push(node);
          if (node.shadowRoot) recurse(node.shadowRoot);
          const children = node.children || node.childNodes || [];
          for (const child of children) {
            if (child.nodeType === 1) recurse(child);
          }
        }
        recurse(root);
        return elements;
      }
      for (const el of getAllElements()) {
        if (el.hasAttribute && el.hasAttribute('data-flow-new-image-index')) {
          el.removeAttribute('data-flow-new-image-index');
        }
      }
    })
    .catch(() => {});

  deleteAnyZipFiles(CONFIG.OUTPUT_DIR);
  return savedFiles;
}

// ==========================================
// MAIN EXECUTION LOOP
// ==========================================
async function main() {
  console.log('======================================================================');
  console.log('🤖 GOOGLE FLOW PUPPETEER IMAGE GENERATION BOT');
  console.log('======================================================================');

  // 1. Load prompts
  const prompts = loadPrompts(CONFIG.PROMPTS_FILE);
  if (prompts.length === 0) {
    console.error('❌ No prompts found in prompts.txt. Please add prompts and rerun.');
    process.exit(1);
  }
  console.log(`📋 Loaded ${prompts.length} prompts from ${path.basename(CONFIG.PROMPTS_FILE)}.`);

  // 2. Initialize timestamped session subfolder so runs never mix or overwrite
  CONFIG.OUTPUT_DIR = generateSessionDir(CONFIG.BASE_OUTPUT_DIR);
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);
  console.log(`📁 Timestamped session directory created: ${CONFIG.OUTPUT_DIR}`);

  // 3. Launch browser and configure initial CDP downloads & network listeners
  const { browser, page: initialPage } = await launchBrowser();
  let page = initialPage;

  try {
    // 4. Navigate to Google Flow Dashboard & handle Google login if required
    await navigateAndHandleLogin(page);

    // 5. Automatically create or open a brand new project workspace (with 12s fallback)
    page = await createNewProject(browser, page);

    // 6. Locate prompt input box in Google Flow
    console.log('🔍 Locating prompt input box in fresh Google Flow workspace...');
    let inputElement = await findPromptInput(page);

    // 7. Automatic Generation Parameters Setup (15s setup countdown + toolbar selection)
    await configureFlowParameters(page);

    // 8. 10-second workspace lock-in window before processing queue
    await waitForWorkspaceLockin(CONFIG.LOCKIN_BUFFER_SECONDS);

    // Initialize session-wide known image signatures set & active zip prevention
    const knownImagesBeforePrompt = new Set();
    const zipWatcher = startZipWatcher(CONFIG.OUTPUT_DIR);
    deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

    // 9. Process prompts strictly in sequential order
    for (let i = 0; i < prompts.length; i++) {
      const promptNumber = i + 1;
      const promptText = prompts[i];

      console.log('\n----------------------------------------------------------------------');
      console.log(`▶️ Processing Prompt ${promptNumber}/${prompts.length}:`);
      console.log(`   "${promptText}"`);
      console.log('----------------------------------------------------------------------');

      try {
        // Step 1: Re-query / re-locate input box in case the DOM re-rendered
        inputElement = await findPromptInput(page);
        if (!inputElement) {
          console.error(`❌ Could not locate prompt input box for prompt #${promptNumber}. Skipping...`);
          continue;
        }

        // Step 2: Hard clear the input box
        console.log('🧹 Clearing previous input text...');
        await hardClearInput(page, inputElement);

        // Step 3: Strict Pre-Prompt Baseline Snapshot (Ignore Old Project Images)
        deleteAnyZipFiles(CONFIG.OUTPUT_DIR);
        console.log('📸 Taking pre-prompt DOM baseline snapshot (recording all old project/history images to ignore)...');
        const prePromptSignatures = await snapshotDOMImageSignatures(page);
        for (const sig of prePromptSignatures) {
          knownImagesBeforePrompt.add(sig);
        }
        console.log(`🔒 Baseline locked: ${knownImagesBeforePrompt.size} signatures recorded. Old/history images will be 100% ignored.`);

        // Step 4: Type current prompt & trigger 100% automatic generation
        console.log('⌨️  Typing prompt and triggering 100% automatic submission...');
        await typeAndTriggerPrompt(page, inputElement, promptText);

        // Step 5: Wait specifically for the 3 new images of the current prompt
        await waitForNewImagesOfPrompt(page, knownImagesBeforePrompt, CONFIG.GENERATION_TIMEOUT_MS);

        // Step 6: Direct Individual PNG Extraction (All 3 Images, Flat Folder, No ZIP)
        const savedFiles = await extractAndSaveNewImages(
          page,
          knownImagesBeforePrompt,
          promptNumber
        );
        console.log(`🎉 Successfully saved ${savedFiles.length}/3 image(s) for prompt #${promptNumber}!`);

        // Final sanity cleanup of any zip files
        deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

        // Step 7: Cooldown & continue
        console.log(`⏱️  Cooling down for ${CONFIG.COOLDOWN_MS / 1000}s...`);
        await sleep(CONFIG.COOLDOWN_MS);

        console.log(`✅ Finished prompt ${promptNumber}/${prompts.length}, moving to next...`);
      } catch (promptErr) {
        console.error(`❌ Error on prompt ${promptNumber}: ${promptErr.message}`);
        console.log('➡️ Continuing to next prompt in queue without crashing...');
        await sleep(3000);
      }
    }


    console.log('\n======================================================================');
    console.log(`🎉 ALL ${prompts.length} PROMPTS PROCESSED SUCCESSFULLY!`);
    console.log(`📁 Downloaded images saved to session folder: ${CONFIG.OUTPUT_DIR}`);
    console.log('======================================================================\n');
  } catch (fatalErr) {
    console.error(`💥 Fatal error: ${fatalErr.message}`);
  } finally {
    console.log('ℹ️ Bot execution complete. Browser will remain open for your inspection.');
    // If you wish to close the browser automatically when finished, uncomment:
    // await browser.close();
  }
}

// Run bot
main().catch((err) => {
  console.error('💥 Unhandled error in main:', err);
  process.exit(1);
});
