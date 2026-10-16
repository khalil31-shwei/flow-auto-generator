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

async function waitForDownloadedFiles(dirPath, baselineFiles, timeoutMs = 6000) {
  const startTime = Date.now();
  const baselineSet = new Set(baselineFiles);

  while (Date.now() - startTime < timeoutMs) {
    const current = getDirectoryFiles(dirPath);
    const newFiles = current.filter((f) => !baselineSet.has(f));

    // Wait until .crdownload or .tmp is finished
    const stillDownloading = newFiles.some((f) => f.endsWith('.crdownload') || f.endsWith('.tmp'));
    if (newFiles.length > 0 && !stillDownloading) {
      return newFiles;
    }
    await sleep(500);
  }
  return [];
}

function renameDownloadedFiles(dirPath, newFiles, promptNumber) {
  const paddedIndex = String(promptNumber).padStart(2, '0');
  const renamed = [];

  for (let k = 0; k < newFiles.length; k++) {
    const oldName = newFiles[k];
    const oldPath = path.join(dirPath, oldName);
    const ext = path.extname(oldName) || '.png';
    const cleanExt = ext.toLowerCase() === '.crdownload' ? '.png' : ext;
    const newName = `prompt_${paddedIndex}_img_${k + 1}${cleanExt}`;
    const newPath = path.join(dirPath, newName);

    try {
      if (oldPath !== newPath) {
        fs.renameSync(oldPath, newPath);
      }
      const displayPath = path.relative(process.cwd(), newPath);
      console.log(`💾 Saved via native download: ${displayPath}`);
      renamed.push(newPath);
    } catch (e) {
      console.warn(`⚠️ Could not rename ${oldName}: ${e.message}`);
    }
  }
  return renamed;
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
// DEEP DOM IMAGE SCANNER (Shadow Roots, Canvas, Bg)
// ==========================================
async function getDeepDOMImages(page) {
  return await page
    .evaluate(() => {
      const collected = [];
      const seenUrls = new Set();

      function isLikelyGeneratedArtwork(w, h, src) {
        if ((w && w < 100) || (h && h < 100)) return false;
        if (src) {
          const lower = src.toLowerCase();
          if (
            lower.includes('favicon') ||
            lower.includes('avatar') ||
            lower.includes('profile') ||
            lower.includes('emoji') ||
            lower.includes('icon_')
          ) {
            return false;
          }
        }
        return true;
      }

      function inspectElement(el) {
        if (!el) return;

        // 1. Check img tags
        if (el.tagName === 'IMG') {
          const src = el.currentSrc || el.src;
          if (src && !seenUrls.has(src)) {
            const rect = el.getBoundingClientRect();
            const w = el.naturalWidth || rect.width;
            const h = el.naturalHeight || rect.height;
            if (isLikelyGeneratedArtwork(w, h, src)) {
              seenUrls.add(src);
              collected.push({
                type: 'img',
                src,
                width: w,
                height: h,
                id: el.id,
                className: el.className,
              });
            }
          }
        }

        // 2. Check canvas
        if (el.tagName === 'CANVAS') {
          if (el.width > 100 && el.height > 100) {
            try {
              const dataUrl = el.toDataURL('image/png');
              if (dataUrl && dataUrl.length > 2000 && !seenUrls.has(dataUrl.slice(0, 100))) {
                seenUrls.add(dataUrl.slice(0, 100));
                collected.push({
                  type: 'canvas',
                  src: dataUrl,
                  width: el.width,
                  height: el.height,
                });
              }
            } catch (e) {}
          }
        }

        // 3. Check CSS background-image
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (bg && bg.startsWith('url(')) {
          const match = bg.match(/url\(["']?(.*?)["']?\)/);
          if (match && match[1] && !seenUrls.has(match[1])) {
            const rect = el.getBoundingClientRect();
            if (isLikelyGeneratedArtwork(rect.width, rect.height, match[1])) {
              seenUrls.add(match[1]);
              collected.push({
                type: 'background',
                src: match[1],
                width: rect.width,
                height: rect.height,
              });
            }
          }
        }

        // 4. Recursive Shadow Root traversal
        if (el.shadowRoot) {
          traverse(el.shadowRoot);
        }
      }

      function traverse(node) {
        if (!node) return;
        inspectElement(node);
        const children = node.children || node.childNodes || [];
        for (const child of children) {
          if (child.nodeType === 1) {
            traverse(child);
          }
        }
      }

      traverse(document.body || document.documentElement);
      return collected;
    })
    .catch(() => []);
}

// ==========================================
// SMART WAIT FOR GENERATION COMPLETION
// ==========================================
async function waitForGenerationToFinish(page, baselineImgCount, timeoutMs = CONFIG.GENERATION_TIMEOUT_MS) {
  const startTime = Date.now();
  console.log(`⏳ Monitoring generation completion (timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  // Wait 4 seconds for generation pipeline to initialize
  await sleep(4000);

  let pollCount = 0;
  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    await sleep(2000);

    const status = await page
      .evaluate(() => {
        const busy =
          !!document.querySelector(
            '[aria-busy="true"], .generating, .loading, [data-state="generating"], mat-progress-bar, mat-spinner, [role="progressbar"]'
          ) || /generating\.\.\.|creating\.\.\.|thinking\.\.\./i.test(document.body ? document.body.innerText : '');

        return { busy };
      })
      .catch(() => ({ busy: false }));

    const currentImgs = await getDeepDOMImages(page);
    const newNetworkArrived = promptNetworkImages.length > 0;
    const newDomArrived = currentImgs.length > baselineImgCount;

    if (pollCount % 5 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `   ⏳ Still generating... (${elapsed}s elapsed, DOM images: ${currentImgs.length}, network images: ${promptNetworkImages.length})`
      );
    }

    // Finished if idle and new content arrived (or after reasonable window)
    if (!status.busy && (newDomArrived || newNetworkArrived || pollCount >= 10)) {
      console.log('✨ Generation complete! Allowing 3s for render stabilization...');
      await sleep(3000);
      return true;
    }
  }

  console.warn('⚠️ Generation wait window reached. Proceeding with multi-layered extraction...');
  return false;
}

// ==========================================
// MULTI-LAYERED BULLETPROOF IMAGE EXTRACTION
// ==========================================
async function captureAndSaveGeneratedImages(page, baselineImages, baselineFiles, promptNumber) {
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);
  const paddedIndex = String(promptNumber).padStart(2, '0');
  const savedFiles = [];

  // ==========================================
  // LAYER 1: Native UI Download Button Click (CDP)
  // ==========================================
  console.log('🔍 [Layer 1] Checking for native UI Download button in Google Flow...');
  try {
    const clicked = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0;
      };

      // 1. Check all buttons for "download"
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a[download]'));
      const downloadBtns = allButtons.filter((b) => {
        const text = (b.innerText || b.getAttribute('aria-label') || b.title || '').toLowerCase();
        return (
          isVisible(b) &&
          (/download/i.test(text) ||
            b.querySelector('svg[data-icon*="download"], [aria-label*="download" i]') !== null)
        );
      });

      if (downloadBtns.length > 0) {
        const latestBtn = downloadBtns[downloadBtns.length - 1];
        latestBtn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        latestBtn.click();
        return { clicked: true, method: 'direct_button' };
      }

      // 2. Hover over the newest image card to reveal download button
      const imageCards = Array.from(
        document.querySelectorAll('img, [role="img"], [data-testid*="image"], [class*="card"]')
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        return isVisible(el) && rect.width > 120 && rect.height > 120;
      });

      if (imageCards.length > 0) {
        const newestCard = imageCards[imageCards.length - 1];
        newestCard.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        newestCard.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        newestCard.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const hoverButtons = Array.from(document.querySelectorAll('button, [role="button"], a[download]')).filter(
          (b) => {
            const text = (b.innerText || b.getAttribute('aria-label') || b.title || '').toLowerCase();
            return isVisible(b) && /download/i.test(text);
          }
        );

        if (hoverButtons.length > 0) {
          hoverButtons[hoverButtons.length - 1].click();
          return { clicked: true, method: 'hover_button' };
        }
      }

      return { clicked: false };
    });

    if (clicked.clicked) {
      console.log(`   🖱️ Triggered UI download (${clicked.method}). Waiting for file via CDP...`);
      const newFiles = await waitForDownloadedFiles(CONFIG.OUTPUT_DIR, baselineFiles, 5000);
      if (newFiles.length > 0) {
        const renamed = renameDownloadedFiles(CONFIG.OUTPUT_DIR, newFiles, promptNumber);
        if (renamed.length > 0) {
          return renamed;
        }
      }
    }
  } catch (err) {
    console.log(`   ⚠️ Layer 1 note: ${err.message}`);
  }

  // ==========================================
  // LAYER 2: In-Browser Fetch & Blob Conversion
  // ==========================================
  console.log('🔍 [Layer 2] Deep DOM image search & browser fetch extraction...');
  try {
    const baselineSrcSet = new Set(baselineImages.map((img) => img.src));
    const currentDeepImages = await getDeepDOMImages(page);
    let targetImages = currentDeepImages.filter((img) => !baselineSrcSet.has(img.src));

    // If no new URLs, take the latest generated images by size
    if (targetImages.length === 0 && currentDeepImages.length > 0) {
      targetImages = [currentDeepImages[currentDeepImages.length - 1]];
    }

    if (targetImages.length > 0) {
      for (let j = 0; j < targetImages.length; j++) {
        const img = targetImages[j];
        const filename = `prompt_${paddedIndex}_img_${j + 1}.png`;
        const filePath = path.join(CONFIG.OUTPUT_DIR, filename);

        const base64Data = await page.evaluate(async (imgSrc) => {
          if (imgSrc.startsWith('data:image/')) {
            return imgSrc.split(',')[1];
          }

          try {
            const res = await fetch(imgSrc, { credentials: 'include' });
            const blob = await res.blob();
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const resUrl = reader.result;
                resolve(resUrl.split(',')[1]);
              };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          } catch (fetchErr) {
            return null;
          }
        }, img.src);

        if (base64Data) {
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
          const displayPath = path.relative(process.cwd(), filePath);
          console.log(`💾 [Layer 2] Saved: ${displayPath}`);
          savedFiles.push(filePath);
        }
      }

      if (savedFiles.length > 0) return savedFiles;
    }
  } catch (err) {
    console.log(`   ⚠️ Layer 2 note: ${err.message}`);
  }

  // ==========================================
  // LAYER 3: Puppeteer Direct Element Screenshot (CORS-immune)
  // ==========================================
  console.log('🔍 [Layer 3] Direct element screenshot (100% CORS-immune compositor capture)...');
  try {
    const tagged = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('img, [role="img"], [data-testid*="image"], [class*="card"], [class*="result"]')
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 120 &&
          rect.height > 120
        );
      });

      if (candidates.length > 0) {
        const recent = candidates.slice(-3);
        recent.forEach((el, idx) => {
          el.setAttribute('data-bot-screenshot-target', String(idx));
        });
        return recent.length;
      }
      return 0;
    });

    if (tagged > 0) {
      for (let k = 0; k < tagged; k++) {
        const handle = await page.$(`[data-bot-screenshot-target="${k}"]`);
        if (handle) {
          const filename = `prompt_${paddedIndex}_img_${k + 1}.png`;
          const filePath = path.join(CONFIG.OUTPUT_DIR, filename);
          await handle.scrollIntoView().catch(() => {});
          await sleep(200);
          await handle.screenshot({ path: filePath, type: 'png' });
          const displayPath = path.relative(process.cwd(), filePath);
          console.log(`💾 [Layer 3] Saved via element screenshot: ${displayPath}`);
          savedFiles.push(filePath);
        }
      }
      if (savedFiles.length > 0) return savedFiles;
    }
  } catch (err) {
    console.log(`   ⚠️ Layer 3 note: ${err.message}`);
  }

  // ==========================================
  // LAYER 4: Intercepted Network Response Buffers
  // ==========================================
  console.log('🔍 [Layer 4] Inspecting intercepted network image responses...');
  try {
    if (promptNetworkImages.length > 0) {
      const sortedImages = promptNetworkImages.sort((a, b) => b.size - a.size);
      const topImages = sortedImages.slice(0, 3);

      for (let k = 0; k < topImages.length; k++) {
        const item = topImages[k];
        const filename = `prompt_${paddedIndex}_img_${k + 1}.png`;
        const filePath = path.join(CONFIG.OUTPUT_DIR, filename);
        fs.writeFileSync(filePath, item.buffer);
        const displayPath = path.relative(process.cwd(), filePath);
        console.log(
          `💾 [Layer 4] Saved from network stream (${Math.round(item.size / 1024)} KB): ${displayPath}`
        );
        savedFiles.push(filePath);
      }
      if (savedFiles.length > 0) return savedFiles;
    }
  } catch (err) {
    console.log(`   ⚠️ Layer 4 note: ${err.message}`);
  }

  // ==========================================
  // LAYER 5: Fallback Viewport Area Screenshot
  // ==========================================
  console.log('🔍 [Layer 5] Viewport capture fallback...');
  try {
    const filename = `prompt_${paddedIndex}_img_1.png`;
    const filePath = path.join(CONFIG.OUTPUT_DIR, filename);
    await page.screenshot({ path: filePath, type: 'png' });
    const displayPath = path.relative(process.cwd(), filePath);
    console.log(`💾 [Layer 5] Saved viewport snapshot: ${displayPath}`);
    savedFiles.push(filePath);
    return savedFiles;
  } catch (err) {
    console.error(`❌ Could not save image for prompt #${promptNumber}: ${err.message}`);
  }

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

        // Step 3: Snapshot existing DOM images and clear prompt response buffer
        const baselineImages = await getDeepDOMImages(page);
        const baselineFiles = getDirectoryFiles(CONFIG.OUTPUT_DIR);
        promptNetworkImages = [];
        console.log(`📸 Existing images on page baseline: ${baselineImages.length}`);

        // Step 4: Type current prompt & trigger 100% automatic generation
        console.log('⌨️  Typing prompt and triggering 100% automatic submission...');
        await typeAndTriggerPrompt(page, inputElement, promptText);

        // Step 5: Smart wait for generation completion
        await waitForGenerationToFinish(page, baselineImages.length);

        // Step 6: Multi-layered image extraction & save into timestamped session folder
        const savedFiles = await captureAndSaveGeneratedImages(
          page,
          baselineImages,
          baselineFiles,
          promptNumber
        );
        console.log(`🎉 Successfully saved ${savedFiles.length} image(s) for prompt #${promptNumber}!`);

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
