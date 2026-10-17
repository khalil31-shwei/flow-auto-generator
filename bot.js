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
const crypto = require('crypto');
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

  // Guard against any subsequent tabs created by Chrome/extensions
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const newPage = await target.page().catch(() => null);
      if (newPage) {
        await configureCdpDownloads(newPage, CONFIG.OUTPUT_DIR);

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
async function typeAndTriggerPrompt(page, inputElement, promptText, onBeforeSubmit = null) {
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

  // Attach temporary listener and initialize capture buffers RIGHT BEFORE clicking Submit/Enter
  if (typeof onBeforeSubmit === 'function') {
    await onBeforeSubmit();
  }

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
// PRE-PROMPT BASELINE: MARK PRE-EXISTING ELEMENTS
// ==========================================
/**
 * Deeply tags all existing <img> and <canvas> elements currently in the DOM
 * (including open shadow roots) with 'data-flow-preexisting="true"'.
 * This guarantees that old project thumbnails, sidebar icons, and prior prompt turns
 * are 100% ignored during scoped fallback extraction.
 */
async function markPreExistingElements(page) {
  try {
    const count = await page.evaluate(() => {
      function getAllElements(root = document.body || document.documentElement) {
        const list = [];
        function recurse(node) {
          if (!node) return;
          list.push(node);
          if (node.shadowRoot) recurse(node.shadowRoot);
          const ch = node.children || node.childNodes || [];
          for (const c of ch) {
            if (c.nodeType === 1) recurse(c);
          }
        }
        recurse(root);
        return list;
      }

      const all = getAllElements();
      let marked = 0;
      for (const el of all) {
        if (el.tagName === 'IMG' || el.tagName === 'CANVAS') {
          el.setAttribute('data-flow-preexisting', 'true');
          marked++;
        }
      }
      return marked;
    });
    console.log(`🔒 Marked ${count} pre-existing image elements. Prior project/turn images will be strictly ignored.`);
  } catch (err) {
    console.warn(`⚠️ Warning marking pre-existing elements: ${err.message}`);
  }
}

// ==========================================
// API JSON BASE64 IMAGE EXTRACTOR
// ==========================================
/**
 * Recursively inspects parsed JSON objects or strings to extract base64-encoded image payloads
 * (e.g. imageBytes, b64_json, encodedImage, bytesBase64Encoded, or data:image/ URIs).
 */
function extractBase64ImagesFromTextOrJson(text) {
  const buffers = [];
  if (!text || typeof text !== 'string') return buffers;

  let cleanText = text.trim();
  // Strip XSSI prefix common in Google APIs (e.g. ")]}'\n")
  if (cleanText.startsWith(")]}'")) {
    cleanText = cleanText.replace(/^\)\]\}'/, '').trim();
  }

  function walkObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) walkObject(item);
      return;
    }
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes('imagebytes') ||
          lowerKey.includes('b64_json') ||
          lowerKey.includes('encodedimage') ||
          lowerKey.includes('bytesbase64encoded') ||
          val.startsWith('data:image/')
        ) {
          let b64 = val;
          if (b64.includes('base64,')) {
            b64 = b64.split('base64,')[1];
          }
          b64 = b64.replace(/\s+/g, '');
          try {
            const buf = Buffer.from(b64, 'base64');
            // Generated images are always > 35 KB
            if (buf.length >= 35000) {
              buffers.push(buf);
            }
          } catch (e) {}
        }
      } else if (typeof val === 'object') {
        walkObject(val);
      }
    }
  }

  try {
    const parsed = JSON.parse(cleanText);
    walkObject(parsed);
    if (buffers.length > 0) return buffers;
  } catch (e) {
    // If not standard single JSON, continue with regex extraction
  }

  // Regex fallback for JSON fields
  const fieldRegex = /"(?:imageBytes|b64_json|encodedImage|bytesBase64Encoded)"\s*:\s*"([A-Za-z0-9+/=]{1000,})"/g;
  let match;
  while ((match = fieldRegex.exec(text)) !== null) {
    try {
      const buf = Buffer.from(match[1], 'base64');
      if (buf.length >= 35000) {
        buffers.push(buf);
      }
    } catch (e) {}
  }

  // Regex fallback for data URIs
  const dataUriRegex = /data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]{1000,})/g;
  while ((match = dataUriRegex.exec(text)) !== null) {
    try {
      const buf = Buffer.from(match[1], 'base64');
      if (buf.length >= 35000) {
        buffers.push(buf);
      }
    } catch (e) {}
  }

  return buffers;
}

// ==========================================
// SCOPED LATEST-TURN FALLBACK (BLOB / MEMORY IMAGES)
// ==========================================
/**
 * Queries ONLY the newly created generation card/container associated with the exact text
 * of Prompt i (never scans the whole document or sidebar).
 * For the 3 images inside that specific container, fetches their blob URLs inside page.evaluate
 * ONLY if their element did not exist prior to submitting Prompt i.
 */
async function queryScopedContainerImages(page, promptText) {
  try {
    return await page.evaluate(async (text) => {
      function getAllElements(root = document.body || document.documentElement) {
        const list = [];
        function rec(node) {
          if (!node) return;
          list.push(node);
          if (node.shadowRoot) rec(node.shadowRoot);
          const ch = node.children || node.childNodes || [];
          for (const c of ch) {
            if (c.nodeType === 1) rec(c);
          }
        }
        rec(root);
        return list;
      }

      function isSidebarOrNav(el) {
        let curr = el;
        while (curr) {
          const tag = (curr.tagName || '').toLowerCase();
          const role = (curr.getAttribute && curr.getAttribute('role')) || '';
          const cls = (curr.className || '').toString().toLowerCase();
          const id = (curr.id || '').toLowerCase();
          if (
            tag === 'nav' ||
            tag === 'aside' ||
            role === 'navigation' ||
            cls.includes('sidebar') ||
            cls.includes('nav') ||
            cls.includes('drawer') ||
            id.includes('sidebar') ||
            id.includes('nav')
          ) {
            return true;
          }
          curr = curr.parentElement;
        }
        return false;
      }

      const allNodes = getAllElements();
      const cleanPrompt = text.trim();
      const snippet = cleanPrompt.slice(0, 35);

      // Locate non-sidebar text nodes matching the exact prompt
      const matchingTextNodes = allNodes.filter((el) => {
        if (isSidebarOrNav(el)) return false;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return false;
        const txt = el.innerText || el.textContent || '';
        return txt.includes(cleanPrompt) || (snippet.length >= 10 && txt.includes(snippet));
      });

      let targetContainer = null;
      // Ascend to the enclosing card/turn that contains non-preexisting images
      for (const node of matchingTextNodes) {
        let curr = node;
        for (let depth = 0; depth < 10 && curr; depth++) {
          if (curr.querySelectorAll) {
            const newImages = Array.from(curr.querySelectorAll('img, canvas')).filter(
              (img) => !img.hasAttribute('data-flow-preexisting')
            );
            if (newImages.length > 0) {
              targetContainer = curr;
              break;
            }
          }
          curr = curr.parentElement;
        }
        if (targetContainer) break;
      }

      // Fallback: If text match was truncated or stylized, look for the latest workspace turn outside nav
      if (!targetContainer) {
        for (let i = allNodes.length - 1; i >= 0; i--) {
          const el = allNodes[i];
          if (isSidebarOrNav(el)) continue;
          if (el.querySelectorAll) {
            const newImages = Array.from(el.querySelectorAll('img, canvas')).filter(
              (img) => !img.hasAttribute('data-flow-preexisting')
            );
            if (newImages.length >= 3) {
              targetContainer = el;
              break;
            }
          }
        }
      }

      if (!targetContainer) {
        return [];
      }

      // Query ONLY the images inside this specific container that did not exist before submitting
      const candidateElements = Array.from(targetContainer.querySelectorAll('img, canvas')).filter(
        (el) => !el.hasAttribute('data-flow-preexisting')
      );

      const dataUrls = [];
      for (const el of candidateElements.slice(0, 3)) {
        if (el.tagName === 'IMG') {
          const src = el.currentSrc || el.src || '';
          if (src.startsWith('blob:') || src.startsWith('http') || src.startsWith('data:image/')) {
            try {
              const res = await fetch(src, { credentials: 'include' });
              const blob = await res.blob();
              const readerResult = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
              if (readerResult && typeof readerResult === 'string' && readerResult.startsWith('data:image/')) {
                dataUrls.push(readerResult);
                continue;
              }
            } catch (fetchErr) {
              // Fetch failed or blocked by CORS, proceed to canvas fallback
            }
          }

          // Offscreen Canvas Draw Fallback
          try {
            const canvas = document.createElement('canvas');
            const w = el.naturalWidth || el.width || 512;
            const h = el.naturalHeight || el.height || 512;
            if (w > 0 && h > 0) {
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(el, 0, 0, w, h);
              const dataUrl = canvas.toDataURL('image/png');
              if (dataUrl && dataUrl.startsWith('data:image/')) {
                dataUrls.push(dataUrl);
              }
            }
          } catch (e) {}
        } else if (el.tagName === 'CANVAS') {
          try {
            const dataUrl = el.toDataURL('image/png');
            if (dataUrl && dataUrl.startsWith('data:image/')) {
              dataUrls.push(dataUrl);
            }
          } catch (e) {}
        }
      }

      return dataUrls;
    }, promptText);
  } catch (err) {
    console.warn(`⚠️ Scoped container fallback error: ${err.message}`);
    return [];
  }
}

// ==========================================
// ACTIVE NETWORK RESPONSE INTERCEPTOR
// ==========================================
/**
 * Attaches a temporary response interceptor to capture direct images (> 35KB) and API JSON base64 payloads.
 * @param {import('puppeteer').Page} page
 * @param {Set<string>} seenHashes Set of tracked URLs and image SHA256 hashes
 * @param {Array<Buffer>} capturedBuffers Array of captured valid image buffers
 * @returns {Function|null} the attached response handler
 */
function attachNetworkResponseListener(page, seenHashes = new Set(), capturedBuffers = []) {
  if (!page) return null;

  const responseHandler = async (response) => {
    try {
      const url = response.url() || '';
      const headers = response.headers ? response.headers() : {};
      const contentType = (headers['content-type'] || '').toLowerCase();

      // A. Direct image responses (image/png, image/jpeg, image/webp, googleusercontent, etc.)
      const isImageContentType =
        contentType.startsWith('image/') ||
        contentType.includes('image/png') ||
        contentType.includes('image/jpeg') ||
        contentType.includes('image/jpg') ||
        contentType.includes('image/webp');

      const isImageUrl =
        /\.(png|jpe?g|webp)(\?.*)?$/i.test(url) ||
        (url.includes('googleusercontent.com') && !url.includes('=s32') && !url.includes('=s64'));

      if (isImageContentType || isImageUrl) {
        if (!seenHashes.has(url)) {
          const buffer = await response.buffer().catch(() => null);
          // Ignore tiny UI assets (buffer.length < 35000 bytes — generated images are always > 35 KB)
          if (buffer && buffer.length >= 35000) {
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            if (!seenHashes.has(hash)) {
              seenHashes.add(url);
              seenHashes.add(hash);
              capturedBuffers.push(buffer);
              console.log(
                `📥 [Network Intercept] Captured direct image #${capturedBuffers.length}/3 (${Math.round(buffer.length / 1024)} KB) from: ${url.slice(0, 75)}...`
              );
            }
          }
        }
        return;
      }

      // B. Google Flow generation API JSON responses containing base64 encoded images
      const isPotentialJsonOrApi =
        contentType.includes('json') ||
        contentType.includes('protobuf') ||
        url.includes('generate') ||
        url.includes('predict') ||
        url.includes('batch') ||
        url.includes('flow') ||
        url.includes('fx');

      if (isPotentialJsonOrApi) {
        if (url.includes('google-analytics') || url.includes('play.google.com/log') || url.includes('doubleclick')) {
          return;
        }

        const text = await response.text().catch(() => null);
        if (
          text &&
          (text.includes('imageBytes') ||
            text.includes('b64_json') ||
            text.includes('encodedImage') ||
            text.includes('bytesBase64Encoded') ||
            text.includes('data:image/'))
        ) {
          const extracted = extractBase64ImagesFromTextOrJson(text);
          for (const buf of extracted) {
            if (buf.length >= 35000) {
              const hash = crypto.createHash('sha256').update(buf).digest('hex');
              if (!seenHashes.has(hash)) {
                seenHashes.add(hash);
                capturedBuffers.push(buf);
                console.log(
                  `📥 [Network Intercept] Extracted API base64 image #${capturedBuffers.length}/3 (${Math.round(buf.length / 1024)} KB)`
                );
              }
            }
          }
        }
      }
    } catch (e) {
      // Safely ignore individual response aborts
    }
  };

  page.on('response', responseHandler);
  return responseHandler;
}

function detachNetworkResponseListener(page, responseHandler) {
  if (!page || !responseHandler) return;
  try {
    if (page.off) {
      page.off('response', responseHandler);
    } else {
      page.removeListener('response', responseHandler);
    }
  } catch (e) {}
}

// ==========================================
// ACTIVE NETWORK INTERCEPTION & 3-PNG CAPTURE
// ==========================================
/**
 * Strictly manages the active prompt generation window:
 * 1. Attaches a temporary page.on('response') listener right BEFORE clicking Submit/Enter.
 * 2. Captures direct image and API JSON base64 payloads, ignoring assets < 35KB.
 * 3. Monitors generation completion and executes scoped turn fallback if fewer than 3 images.
 * 4. Detaches listener in finally block.
 * 5. Saves exactly 3 standalone PNGs per prompt (prompt_XX_img_Y.png) with KB sizes logged.
 */
async function generateAndCapturePromptImages(page, inputElement, promptText, promptNumber) {
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);
  deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

  const capturedBuffers = [];
  const seenKeys = new Set();
  let responseHandler = null;

  try {
    // 1. Setup hook to initialize buffers and attach listener right BEFORE clicking Submit/Enter
    const onBeforeSubmit = async () => {
      console.log(`🎧 Attaching temporary network response listener for Prompt #${promptNumber}...`);
      responseHandler = attachNetworkResponseListener(page, seenKeys, capturedBuffers);
    };

    // 2. Type prompt and trigger submission with active pre-submit hook
    console.log('⌨️  Typing prompt and triggering 100% automatic submission...');
    await typeAndTriggerPrompt(page, inputElement, promptText, onBeforeSubmit);

    // 3. Active generation monitoring & network image capture
    console.log(`⏳ Monitoring generation & network image capture (timeout: ${Math.round(CONFIG.GENERATION_TIMEOUT_MS / 1000)}s)...`);
    const startTime = Date.now();
    let generationFinishedTimestamp = null;
    let pollCount = 0;

    while (Date.now() - startTime < CONFIG.GENERATION_TIMEOUT_MS) {
      pollCount++;
      deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

      // Fast exit if all 3 images are captured via network
      if (capturedBuffers.length >= 3) {
        console.log(`🎯 Captured all 3 images via active network interception!`);
        break;
      }

      // Check UI generation / busy status
      const isBusy = await page.evaluate(() => {
        function getAll(root = document.body || document.documentElement) {
          const list = [];
          function rec(n) {
            if (!n) return;
            list.push(n);
            if (n.shadowRoot) rec(n.shadowRoot);
            const ch = n.children || n.childNodes || [];
            for (const c of ch) {
              if (c.nodeType === 1) rec(c);
            }
          }
          rec(root);
          return list;
        }

        const nodes = getAll();
        for (const el of nodes) {
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
            return true;
          }
        }
        const text = (document.body ? document.body.innerText : '') || '';
        return /generating\.\.\.|creating\.\.\.|thinking\.\.\./i.test(text);
      }).catch(() => false);

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (isBusy) {
        generationFinishedTimestamp = null;
        if (pollCount % 5 === 0) {
          console.log(`   ⏳ Generating... ${elapsed}s elapsed | Captured: ${capturedBuffers.length}/3 images`);
        }
      } else {
        if (elapsed >= 3) {
          if (generationFinishedTimestamp === null) {
            generationFinishedTimestamp = Date.now();
            console.log(`🏁 Generation completed in UI at ${elapsed}s. Waiting for image payloads (captured: ${capturedBuffers.length}/3)...`);
          }

          const secondsSinceFinish = Math.round((Date.now() - generationFinishedTimestamp) / 1000);
          if (capturedBuffers.length < 3 && secondsSinceFinish >= 45) {
            console.log(`⚠️ Network listener captured ${capturedBuffers.length}/3 images within 45s after generation completed.`);
            console.log(`🔄 Activating Scoped Latest-Turn Fallback (querying only container for Prompt #${promptNumber})...`);
            break;
          }
        }
      }

      await sleep(1000);
    }

    // 4. Scoped Latest-Turn Fallback if fewer than 3 images captured via network
    if (capturedBuffers.length < 3) {
      console.log(`🔍 [Scoped Fallback] Searching DOM specifically within the prompt card for: "${promptText.slice(0, 40)}..."`);
      const fallbackDataUrls = await queryScopedContainerImages(page, promptText);
      console.log(`🔍 [Scoped Fallback] Found ${fallbackDataUrls.length} newly rendered image(s) in prompt container.`);

      for (const dataUrl of fallbackDataUrls) {
        if (capturedBuffers.length >= 3) break;
        const base64Data = dataUrl.split(',')[1];
        if (base64Data) {
          const buf = Buffer.from(base64Data, 'base64');
          if (buf.length >= 35000) {
            const hash = crypto.createHash('sha256').update(buf).digest('hex');
            if (!seenKeys.has(hash)) {
              seenKeys.add(hash);
              capturedBuffers.push(buf);
              console.log(
                `📥 [Scoped Fallback] Extracted container image #${capturedBuffers.length}/3 (${Math.round(buf.length / 1024)} KB)`
              );
            }
          }
        }
      }
    }
  } finally {
    // 5. Detach listener as soon as prompt finishes or 3 images are captured
    if (responseHandler) {
      detachNetworkResponseListener(page, responseHandler);
      console.log(`🔌 Detached network response listener for Prompt #${promptNumber}.`);
    }
  }

  // 6. Save up to 3 captured buffers directly to disk as individual PNG files (Strictly No ZIPs)
  const paddedIndex = String(promptNumber).padStart(2, '0');
  const savedFiles = [];

  for (let j = 0; j < Math.min(3, capturedBuffers.length); j++) {
    const imgIndex = j + 1;
    const filename = `prompt_${paddedIndex}_img_${imgIndex}.png`;
    const filePath = path.join(CONFIG.OUTPUT_DIR, filename);
    const buf = capturedBuffers[j];

    try {
      fs.writeFileSync(filePath, buf);
      const sizeKb = Math.round(buf.length / 1024);
      console.log(`💾 Saved ${filename} (${sizeKb} KB)`);
      savedFiles.push(filePath);
    } catch (saveErr) {
      console.error(`❌ Error writing ${filename}: ${saveErr.message}`);
    }
  }

  if (savedFiles.length < 3) {
    console.warn(`⚠️ Notice: Saved ${savedFiles.length}/3 images for prompt #${promptNumber}.`);
  }

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

    // Initialize active zip prevention watcher
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

        // Step 3: Strict Pre-Prompt Baseline (Tag Existing Elements so Old Images are Ignored)
        deleteAnyZipFiles(CONFIG.OUTPUT_DIR);
        console.log('📸 Marking pre-prompt elements to ignore old project/turn images...');
        await markPreExistingElements(page);

        // Step 4 & 5: Active Network Interception & 3-PNG Capture (with Scoped Turn Fallback)
        const savedFiles = await generateAndCapturePromptImages(
          page,
          inputElement,
          promptText,
          promptNumber
        );
        console.log(`🎉 Successfully saved ${savedFiles.length}/3 image(s) for prompt #${promptNumber}!`);

        // Final sanity cleanup of any zip files
        deleteAnyZipFiles(CONFIG.OUTPUT_DIR);

        // Step 6: Cooldown & continue
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
