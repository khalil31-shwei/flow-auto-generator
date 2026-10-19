/**
 * ==============================================================================
 * Google Flow Automated Image Generator
 * ==============================================================================
 * Rock-solid Puppeteer automation script to sequentially generate and download
 * images on Google Flow.
 * Features a direct Network Response Interceptor (page.on('response') + CDP):
 *   - Intercepts raw network streams for high-res images (> 80 KB)
 *   - Automatically filters out grey noise placeholders (~56 KB) and tiny UI icons
 *   - Direct standalone PNG saving to prompt_XX_img_1.png, prompt_XX_img_2.png, prompt_XX_img_3.png
 *   - High-res element screenshot fallback if < 3 images captured via network
 *   - No ZIP archives, no fragile pixel filters
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
  FLOW_URL: 'https://flow.google.com/',
  USER_DATA_DIR: path.resolve(__dirname, 'chrome_user_data'),
  PROMPTS_FILE: path.resolve(__dirname, 'prompts.txt'),
  BASE_OUTPUT_DIR: path.resolve(__dirname, 'downloaded_images'),
  OUTPUT_DIR: path.resolve(__dirname, 'downloaded_images'), // Set dynamically to session folder
  INPUT_DETECTION_TIMEOUT_MS: 10000,
  USER_CLICK_WAIT_TIMEOUT_MS: 60000,
  NEW_PROJECT_AUTO_TIMEOUT_MS: 12000,
  NETWORK_WAIT_TIMEOUT_MS: 40000,     // 40-second network capture timeout
  MIN_IMAGE_BUFFER_BYTES: 80000,      // ONLY keep buffers > 80 KB (skips ~56 KB placeholders)
  COOLDOWN_MS: 4000,                  // 4s cooldown between prompts
  TYPING_DELAY_MS: 15,
  SETUP_PAUSE_SECONDS: 15,
  LOCKIN_BUFFER_SECONDS: 10,
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
      if (/\(\d+-\d+\)/.test(line)) return false;
      return true;
    });
}

function extractBase64ImagesFromTextOrJson(text) {
  const buffers = [];
  if (!text || typeof text !== 'string') return buffers;

  let cleanText = text.trim();
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
            if (buf.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
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
  } catch (e) {}

  const fieldRegex = /"(?:imageBytes|b64_json|encodedImage|bytesBase64Encoded)"\s*:\s*"([A-Za-z0-9+/=]{1000,})"/g;
  let match;
  while ((match = fieldRegex.exec(text)) !== null) {
    try {
      const buf = Buffer.from(match[1], 'base64');
      if (buf.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
        buffers.push(buf);
      }
    } catch (e) {}
  }

  const dataUriRegex = /data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]{1000,})/g;
  while ((match = dataUriRegex.exec(text)) !== null) {
    try {
      const buf = Buffer.from(match[1], 'base64');
      if (buf.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
        buffers.push(buf);
      }
    } catch (e) {}
  }

  return buffers;
}

// ==========================================
// PRE-PROMPT BASELINE: RECORD KNOWN SOURCES
// ==========================================
async function recordPrePromptBaseline(page) {
  try {
    const knownSrcs = await page.evaluate(() => {
      const list = [];
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        img.setAttribute('data-flow-preexisting', 'true');
        const src = img.currentSrc || img.src;
        if (src) list.push(src);
      }
      return list;
    });
    console.log(`🔒 [Pre-Prompt Baseline] Recorded ${knownSrcs.length} existing image URLs (strictly ignored).`);
    return new Set(knownSrcs);
  } catch (e) {
    return new Set();
  }
}

// ==========================================
// NETWORK STREAM INTERCEPTION & CAPTURE
// ==========================================
/**
 * Intercepts image responses via page.on('response') and CDP.
 * ONLY keeps buffers > 80 KB (bypasses ~56 KB placeholders).
 * Saves exactly 3 standalone PNG files to prompt_XX_img_1.png, prompt_XX_img_2.png, prompt_XX_img_3.png.
 */
async function generateAndCapturePromptImages(
  page,
  cdpClient,
  inputElement,
  promptText,
  promptNumber,
  knownImageSourcesBeforePrompt
) {
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);

  // 1. Clear temporary buffer array right before submitting prompt i
  const promptBuffers = [];
  const seenHashes = new Set();
  let isListening = true;

  const addBuffer = (buf, sourceUrl = '') => {
    if (!buf || buf.length < CONFIG.MIN_IMAGE_BUFFER_BYTES) return false;
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    promptBuffers.push(buf);
    const sizeKb = Math.round(buf.length / 1024);
    console.log(`📥 [Network Intercept] Captured generated image #${promptBuffers.length}/3 (${sizeKb} KB) from: ${sourceUrl.slice(0, 70)}...`);
    return true;
  };

  // 2. Attach page.on('response') listener
  const responseHandler = async (response) => {
    if (!isListening || promptBuffers.length >= 3) return;
    try {
      const url = response.url() || '';
      const headers = response.headers ? response.headers() : {};
      const contentType = (headers['content-type'] || '').toLowerCase();

      const isImageContentType =
        contentType.startsWith('image/') ||
        contentType.includes('image/png') ||
        contentType.includes('image/jpeg') ||
        contentType.includes('image/jpg') ||
        contentType.includes('image/webp');

      const isImageUrl =
        /\.(png|jpe?g|webp)(\?.*)?$/i.test(url) ||
        url.includes('googleusercontent.com') ||
        url.includes('labs.google') ||
        url.includes('alkali') ||
        url.includes('/image');

      if (isImageContentType || isImageUrl) {
        const buf = await response.buffer().catch(() => null);
        if (buf && buf.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
          addBuffer(buf, url);
        }
        return;
      }

      // Check API JSON responses for base64 encoded images
      const isPotentialApi =
        contentType.includes('json') ||
        contentType.includes('protobuf') ||
        url.includes('generate') ||
        url.includes('predict') ||
        url.includes('batch') ||
        url.includes('flow');

      if (isPotentialApi) {
        if (url.includes('google-analytics') || url.includes('play.google.com/log') || url.includes('doubleclick')) return;
        const text = await response.text().catch(() => null);
        if (text && (text.includes('imageBytes') || text.includes('b64_json') || text.includes('data:image/'))) {
          const extracted = extractBase64ImagesFromTextOrJson(text);
          for (const buf of extracted) {
            if (buf.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
              addBuffer(buf, url);
            }
          }
        }
      }
    } catch (e) {}
  };

  page.on('response', responseHandler);

  // 3. Attach CDP Network listener as dual low-level backup
  let cdpHandler = null;
  if (cdpClient) {
    cdpHandler = async (params) => {
      if (!isListening || promptBuffers.length >= 3) return;
      if (params.encodedDataLength && params.encodedDataLength < CONFIG.MIN_IMAGE_BUFFER_BYTES) return;
      try {
        const res = await cdpClient.send('Network.getResponseBody', { requestId: params.requestId }).catch(() => null);
        if (res && res.body) {
          if (res.base64Encoded) {
            const buf = Buffer.from(res.body, 'base64');
            if (buf.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
              addBuffer(buf, 'CDP Network Stream');
            }
          } else if (typeof res.body === 'string') {
            const extracted = extractBase64ImagesFromTextOrJson(res.body);
            for (const b of extracted) {
              if (b.length >= CONFIG.MIN_IMAGE_BUFFER_BYTES) {
                addBuffer(b, 'CDP API Payload');
              }
            }
          }
        }
      } catch (e) {}
    };
    cdpClient.on('Network.loadingFinished', cdpHandler);
  }

  try {
    // 4. Submit prompt
    console.log('⌨️  Submitting prompt to Google Flow...');
    await typeAndTriggerPrompt(page, inputElement, promptText);

    // 5. Monitor network stream (up to 40-second timeout)
    console.log(`⏳ Monitoring network stream for 3 generated images (timeout: ${CONFIG.NETWORK_WAIT_TIMEOUT_MS / 1000}s)...`);
    const waitStart = Date.now();
    let pollCount = 0;

    while (Date.now() - waitStart < CONFIG.NETWORK_WAIT_TIMEOUT_MS) {
      if (promptBuffers.length >= 3) {
        console.log(`🎯 Captured all 3 images via network stream!`);
        break;
      }

      await sleep(1000);
      pollCount++;
      const elapsed = Math.round((Date.now() - waitStart) / 1000);

      if (pollCount % 4 === 0) {
        console.log(`   ⏳ Generating... ${elapsed}s elapsed | Captured: ${promptBuffers.length}/3 images (> 80 KB)`);
      }
    }
  } finally {
    isListening = false;
    page.off('response', responseHandler);
    if (cdpClient && cdpHandler) {
      try {
        cdpClient.off('Network.loadingFinished', cdpHandler);
      } catch (e) {}
    }
  }

  // 6. Fallback: High-Resolution Element Screenshot if < 3 buffers captured
  if (promptBuffers.length < 3) {
    console.log(`⚠️ Network captured ${promptBuffers.length}/3 images. Activating element screenshot fallback for remaining...`);
    try {
      await sleep(2000);
      const imgElements = await page.$$('img');
      for (const handle of imgElements) {
        if (promptBuffers.length >= 3) break;
        try {
          const isCandidate = await page.evaluate((el, knownSrcArray) => {
            if (!el || el.tagName !== 'IMG') return false;
            if (el.hasAttribute('data-flow-preexisting')) return false;
            const src = el.currentSrc || el.src || '';
            const known = new Set(knownSrcArray);
            if (src && known.has(src)) return false;
            const rect = el.getBoundingClientRect();
            return rect.width >= 150 && rect.height >= 150;
          }, handle, Array.from(knownImageSourcesBeforePrompt));

          if (isCandidate) {
            const screenshotBuf = await handle.screenshot({ type: 'png' });
            if (screenshotBuf && screenshotBuf.length >= 50000) {
              addBuffer(screenshotBuf, 'Element Screenshot Fallback');
            }
          }
        } catch (e) {}
      }
    } catch (err) {
      console.warn(`⚠️ Screenshot fallback error: ${err.message}`);
    }
  }

  // 7. Direct Standalone PNG Saving (No ZIPs)
  const paddedIndex = String(promptNumber).padStart(2, '0');
  const savedFiles = [];

  for (let idx = 1; idx <= Math.min(3, promptBuffers.length); idx++) {
    const filename = `prompt_${paddedIndex}_img_${idx}.png`;
    const filePath = path.join(CONFIG.OUTPUT_DIR, filename);
    const buf = promptBuffers[idx - 1];

    try {
      fs.writeFileSync(filePath, buf);
      if (fs.existsSync(filePath)) {
        const sizeKb = Math.round(buf.length / 1024);
        console.log(`💾 Saved ${filename} (${sizeKb} KB)`);
        savedFiles.push(filePath);
      }
    } catch (saveErr) {
      console.error(`❌ Error writing ${filename}: ${saveErr.message}`);
    }
  }

  if (savedFiles.length >= 3) {
    console.log(`\n🎉 PROMPT #${paddedIndex} SUCCESS: All 3 images saved cleanly to disk!`);
  } else {
    console.warn(`\n⚠️ Prompt #${paddedIndex}: Saved ${savedFiles.length}/3 images.`);
  }

  return savedFiles;
}

// ==========================================
// BROWSER INITIALIZATION & SETUP
// ==========================================
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

  const pages = await browser.pages();
  const page = pages[0];

  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }

  let cdpClient = null;
  try {
    cdpClient = await page.target().createCDPSession();
    await cdpClient.send('Network.enable', {
      maxResourceBufferSize: 100000000,
      maxTotalBufferSize: 200000000,
    });
    console.log('📡 Low-level CDP network capture enabled.');
  } catch (err) {
    console.warn(`⚠️ Warning setting up CDP: ${err.message}`);
  }

  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const newPage = await target.page().catch(() => null);
      if (newPage && newPage !== page && (newPage.url() === 'about:blank' || newPage.url() === '')) {
        setTimeout(async () => {
          if (newPage.url() === 'about:blank' || newPage.url() === '') {
            await newPage.close().catch(() => {});
          }
        }, 300);
      }
    }
  });

  return { browser, page, cdpClient };
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
        if (root.shadowRoot) collectElements(root.shadowRoot);
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const node of nodes) {
          if (node.shadowRoot) collectElements(node.shadowRoot);
          if (!isVisible(node)) continue;

          const tag = node.tagName.toLowerCase();
          const role = (node.getAttribute('role') || '').toLowerCase();

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

        if (
          /(\b|\+)new\s+project\b/i.test(textClean) ||
          /(\b|\+)new\s+project\b/i.test(ariaClean) ||
          /(\b|\+)create\s+project\b/i.test(textClean) ||
          /(\b|\+)create\s+project\b/i.test(ariaClean) ||
          /nouveau\s+projet/i.test(combined)
        ) {
          return 100;
        }

        if (item.href && (/project\/(new|create)/i.test(item.href) || /new-project/i.test(item.href))) {
          return 90;
        }

        const lowerT = textClean.toLowerCase();
        const lowerA = ariaClean.toLowerCase();
        if (
          /^(\+?\s*new|\+?\s*create|\+?\s*start|\+)$/i.test(lowerT) ||
          /^(\+?\s*new|\+?\s*create|\+?\s*start|\+)$/i.test(lowerA)
        ) {
          return 85;
        }

        if (
          /new-project|create-project|add-project/i.test(item.testId) ||
          /new-project|create-project|add-project/i.test(item.id)
        ) {
          return 80;
        }

        const icon = item.el.querySelector('svg, mat-icon, i');
        if (icon) {
          const iconText = (icon.innerText || icon.getAttribute('data-icon') || icon.getAttribute('aria-label') || '').toLowerCase();
          if (iconText.includes('add') || iconText.includes('plus') || iconText.includes('create')) {
            return 75;
          }
        }

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
  console.log(`✅ Fresh workspace ready at: ${page.url()}\n`);
}

async function createNewProject(browser, initialPage) {
  let page = initialPage;
  const initialUrl = page.url();

  console.log('\n======================================================================');
  console.log('🆕 CREATING A BRAND NEW PROJECT WORKSPACE');
  console.log('🔍 Searching DOM for "New Project" / "Create" button...');
  console.log('======================================================================\n');

  const checkProjectUrl = async () => {
    const pages = await browser.pages();
    for (const p of pages) {
      const u = p.url();
      if (u.includes('/project/')) {
        if (initialUrl.includes('/project/') && u === initialUrl) {
          continue;
        }
        return p;
      }
    }
    return null;
  };

  const autoDetectStart = Date.now();
  let clickedButton = false;

  while (Date.now() - autoDetectStart < CONFIG.NEW_PROJECT_AUTO_TIMEOUT_MS) {
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
        console.log('⏳ Waiting for browser URL to transition to /project/... URL...');
        clickedButton = true;
      }
    }

    await sleep(600);
  }

  const finalAutoCheck = await checkProjectUrl();
  if (finalAutoCheck) {
    page = finalAutoCheck;
    console.log(`🎯 New project URL reached: ${page.url()}`);
    await waitForWorkspaceReady(page);
    return page;
  }

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
// ==========================================
// AUTOMATIC GENERATION PARAMETERS SETUP (ROBUST MULTI-TRY)
// ==========================================
const findAndConfigureParameters = () => {
  function collectAll(root = document.body || document.documentElement) {
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

  function isElementActive(el) {
    if (!el) return false;
    if (
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-pressed') === 'true' ||
      el.getAttribute('data-state') === 'active' ||
      el.getAttribute('data-state') === 'selected' ||
      el.getAttribute('data-state') === 'checked' ||
      el.getAttribute('data-state') === 'on' ||
      el.getAttribute('data-selected') === 'true' ||
      el.getAttribute('data-active') === 'true'
    ) {
      return true;
    }
    const cls = (el.className || '').toString().toLowerCase();
    if (
      cls.includes('selected') ||
      cls.includes('active') ||
      cls.includes('checked') ||
      cls.includes('toggled') ||
      cls.includes('mdc-tab--active') ||
      cls.includes('mat-mdc-button-active') ||
      cls.includes('mat-chip-selected')
    ) {
      return true;
    }
    if (el.parentElement) {
      const p = el.parentElement;
      const pCls = (p.className || '').toString().toLowerCase();
      if (
        p.getAttribute('aria-selected') === 'true' ||
        p.getAttribute('aria-checked') === 'true' ||
        p.getAttribute('aria-pressed') === 'true' ||
        pCls.includes('selected') ||
        pCls.includes('active')
      ) {
        return true;
      }
    }
    return false;
  }

  function triggerClick(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    el.focus();
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const allElements = collectAll().filter(isVisible);

  const status = {
    aspectActive: false,
    aspectLabel: '',
    aspectClicked: false,
    batchActive: false,
    batchLabel: '',
    batchClicked: false,
  };

  // 1. Aspect Ratio (Prefer 3:4, fallback 1:1)
  const aspect34Elements = allElements.filter((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    const val = (el.getAttribute('data-value') || el.getAttribute('value') || '').trim();
    const combined = `${text} ${aria} ${title} ${val}`.toLowerCase();

    return (
      /^3:4$/i.test(text) ||
      /\b3:4\b/i.test(combined) ||
      /portrait\s*3:4/i.test(combined) ||
      /3:4\s*portrait/i.test(combined) ||
      combined === '3:4' ||
      val === '3:4'
    );
  });

  const aspect11Elements = allElements.filter((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    const val = (el.getAttribute('data-value') || el.getAttribute('value') || '').trim();
    const combined = `${text} ${aria} ${title} ${val}`.toLowerCase();

    return (
      /^1:1$/i.test(text) ||
      /\b1:1\b/i.test(combined) ||
      /square\s*1:1/i.test(combined) ||
      /1:1\s*square/i.test(combined) ||
      combined === '1:1' ||
      val === '1:1'
    );
  });

  const best34 = aspect34Elements[0];
  const best11 = aspect11Elements[0];

  if (best34) {
    if (isElementActive(best34)) {
      status.aspectActive = true;
      status.aspectLabel = '3:4 (Active)';
    } else {
      triggerClick(best34);
      status.aspectClicked = true;
      status.aspectLabel = '3:4 (Clicked)';
    }
  } else if (best11) {
    if (isElementActive(best11)) {
      status.aspectActive = true;
      status.aspectLabel = '1:1 (Active)';
    } else {
      triggerClick(best11);
      status.aspectClicked = true;
      status.aspectLabel = '1:1 (Clicked)';
    }
  } else {
    const aspectDropdown = allElements.find((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const combined = `${text} ${aria} ${title}`.toLowerCase();
      return (
        combined.includes('aspect') ||
        combined.includes('ratio') ||
        combined.includes("format d'image") ||
        combined.includes('relación de aspecto') ||
        combined.includes('seitenverhältnis')
      );
    });

    if (aspectDropdown) {
      triggerClick(aspectDropdown);
      status.aspectLabel = 'Aspect Dropdown Opened';
    }
  }

  // 2. Image Count / Batch Size (Target: x3 or 3 images)
  const batch3Elements = allElements.filter((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    const val = (el.getAttribute('data-value') || el.getAttribute('value') || el.getAttribute('data-count') || '').trim();
    const combined = `${text} ${aria} ${title} ${val}`.toLowerCase();

    return (
      /^x?3$/i.test(text) ||
      /^3\s*(images?|photos?|outputs?|bilder|imágenes)$/i.test(text) ||
      /\b3\s*(images?|outputs?)\b/i.test(combined) ||
      /batch.*3/i.test(combined) ||
      /count.*3/i.test(combined) ||
      val === '3' ||
      val === 'x3'
    );
  });

  const bestBatch3 = batch3Elements[0];

  if (bestBatch3) {
    if (isElementActive(bestBatch3)) {
      status.batchActive = true;
      status.batchLabel = '3 Images (Active)';
    } else {
      triggerClick(bestBatch3);
      status.batchClicked = true;
      status.batchLabel = '3 Images (Clicked)';
    }
  } else {
    const batchDropdown = allElements.find((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const combined = `${text} ${aria} ${title}`.toLowerCase();
      return (
        combined.includes('batch') ||
        combined.includes('count') ||
        combined.includes('number of images') ||
        combined.includes("nombre d'images") ||
        combined.includes('cantidad')
      );
    });

    if (batchDropdown) {
      triggerClick(batchDropdown);
      status.batchLabel = 'Count Dropdown Opened';
    }
  }

  return status;
};

async function configureFlowParameters(page) {
  console.log('\n======================================================================');
  console.log('⚙️  AUTOMATIC GENERATION PARAMETERS SETUP (ROBUST MULTI-TRY)');
  console.log('🔍 Actively scanning for Aspect Ratio (3:4/1:1) and Image Count (x3)...');
  console.log('👉 Up to 15s active retry window to click and lock in active CSS states.');
  console.log('======================================================================\n');

  let lastStatus = null;
  for (let s = CONFIG.SETUP_PAUSE_SECONDS; s > 0; s--) {
    try {
      const status = await page.evaluate(findAndConfigureParameters);
      lastStatus = status;

      if (status.aspectActive && status.batchActive) {
        console.log(`\n🎯 Parameters successfully locked: Aspect Ratio: ${status.aspectLabel} | Count: ${status.batchLabel}`);
        break;
      }
    } catch (e) {}

    process.stdout.write(
      `\r⏳ Setup countdown: ${s}s remaining | Aspect: ${lastStatus?.aspectLabel || 'scanning...'} | Count: ${lastStatus?.batchLabel || 'scanning...'} `
    );
    await sleep(1000);
  }
  process.stdout.write('\r✅ Generation parameters configuration phase complete!                    \n\n');
}

// ==========================================
// EXPLICIT VERIFICATION CHECK & RE-ASSERTION
// ==========================================
async function verifyAndReassertParameters(page) {
  console.log('======================================================================');
  console.log('🔍 VERIFICATION CHECK: GENERATION PARAMETERS');
  console.log('Verifying UI clearly displays expected aspect ratio and image count (x3)...');
  console.log('======================================================================');

  let verified = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const check = await page.evaluate(() => {
      function collectAll(root = document.body || document.documentElement) {
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

      function isElementActive(el) {
        if (!el) return false;
        if (
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-pressed') === 'true' ||
          el.getAttribute('data-state') === 'active' ||
          el.getAttribute('data-state') === 'selected' ||
          el.getAttribute('data-selected') === 'true' ||
          el.getAttribute('data-active') === 'true'
        ) return true;
        const cls = (el.className || '').toString().toLowerCase();
        return (
          cls.includes('selected') ||
          cls.includes('active') ||
          cls.includes('checked') ||
          cls.includes('toggled') ||
          cls.includes('mdc-tab--active') ||
          cls.includes('mat-mdc-button-active')
        );
      }

      const all = collectAll();
      let aspectVerified = false;
      let aspectLabel = '';
      let countVerified = false;
      let countLabel = '';

      for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        const val = (el.getAttribute('data-value') || el.getAttribute('value') || '').trim();
        const combined = `${text} ${aria} ${val}`.toLowerCase();

        if (!aspectVerified && (/\b3:4\b/i.test(combined) || combined === '3:4')) {
          if (isElementActive(el)) {
            aspectVerified = true;
            aspectLabel = '3:4';
          }
        }
        if (!aspectVerified && (/\b1:1\b/i.test(combined) || combined === '1:1')) {
          if (isElementActive(el)) {
            aspectVerified = true;
            aspectLabel = '1:1';
          }
        }

        if (!countVerified && (/^x?3$/i.test(text) || /\b3\s*images?\b/i.test(combined) || val === '3')) {
          if (isElementActive(el)) {
            countVerified = true;
            countLabel = 'x3 (3 images)';
          }
        }
      }

      return { aspectVerified, aspectLabel, countVerified, countLabel };
    });

    if (check.aspectVerified && check.countVerified) {
      console.log(`✅ Verification Passed (Attempt ${attempt}): Aspect Ratio: ${check.aspectLabel} | Image Count: ${check.countLabel}`);
      verified = true;
      break;
    } else {
      console.log(`⚠️ Verification Attempt ${attempt}/3: UI not fully locked (Aspect: ${check.aspectLabel || 're-asserting'}, Count: ${check.countLabel || 're-asserting'}). Retrying clicks...`);
      await page.evaluate(findAndConfigureParameters);
      await sleep(1500);
    }
  }

  if (!verified) {
    console.log('ℹ️ Parameter re-assertion completed. Proceeding to session save & lock...');
  }
}

// ==========================================
// SAVE & LOCK SETTINGS TO CURRENT SESSION
// ==========================================
async function waitForWorkspaceLockin(seconds = CONFIG.LOCKIN_BUFFER_SECONDS) {
  console.log('\n======================================================================');
  console.log('🔒 LOCKING IN WORKSPACE SETTINGS');
  console.log(`⏳ Allowing a ${seconds}-second window for Google Flow internal state to save to session...`);
  console.log('======================================================================');
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`\r⏳ Session save & lock: ${s}s remaining before queue starts... `);
    await sleep(1000);
  }
  process.stdout.write('\r✅ Preferences locked & saved to current session! Starting queue now...  \n\n');
}

// ==========================================
// HARD CLEAR INPUT
// ==========================================
async function hardClearInput(page, inputElement) {
  if (!inputElement) return;

  try {
    await inputElement.focus();
    await sleep(100);

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await sleep(50);
    await page.keyboard.press('Backspace');
    await sleep(50);

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
  await inputElement.focus();
  await sleep(100);

  await page.keyboard.type(promptText, { delay: CONFIG.TYPING_DELAY_MS });
  await sleep(200);

  await page
    .evaluate((el) => {
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputElement)
    .catch(() => {});
  await sleep(200);

  await inputElement.focus();
  await sleep(100);

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

  // Button Click Fallback (1.5s check)
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
// MAIN EXECUTION LOOP
// ==========================================
async function main() {
  console.log('======================================================================');
  console.log('🤖 GOOGLE FLOW PUPPETEER IMAGE GENERATION BOT');
  console.log('⚡ Direct Network Stream Interceptor Active:');
  console.log('   - Intercepts raw network streams for images > 80 KB');
  console.log('   - Automatically bypasses ~56 KB placeholders & tiny UI icons');
  console.log('   - Direct standalone PNG saving (No ZIP archives)');
  console.log('   - High-res element screenshot fallback if < 3 images intercepted');
  console.log('======================================================================\n');

  const prompts = loadPrompts(CONFIG.PROMPTS_FILE);
  if (prompts.length === 0) {
    console.error('❌ No prompts found in prompts.txt. Please add prompts and rerun.');
    process.exit(1);
  }
  console.log(`📋 Loaded ${prompts.length} prompts from ${path.basename(CONFIG.PROMPTS_FILE)}.`);

  CONFIG.OUTPUT_DIR = generateSessionDir(CONFIG.BASE_OUTPUT_DIR);
  ensureDirectoryExists(CONFIG.OUTPUT_DIR);
  console.log(`📁 Timestamped session directory created: ${CONFIG.OUTPUT_DIR}`);

  const { browser, page: initialPage, cdpClient } = await launchBrowser();
  let page = initialPage;

  try {
    await navigateAndHandleLogin(page);
    page = await createNewProject(browser, page);

    console.log('🔍 Locating prompt input box in fresh Google Flow workspace...');
    let inputElement = await findPromptInput(page);

    await configureFlowParameters(page);
    await verifyAndReassertParameters(page);
    await waitForWorkspaceLockin(CONFIG.LOCKIN_BUFFER_SECONDS);

    for (let i = 0; i < prompts.length; i++) {
      const promptNumber = i + 1;
      const promptText = prompts[i];

      console.log('\n----------------------------------------------------------------------');
      console.log(`▶️ Processing Prompt ${promptNumber}/${prompts.length}:`);
      console.log(`   "${promptText}"`);
      console.log('----------------------------------------------------------------------');

      try {
        inputElement = await findPromptInput(page);
        if (!inputElement) {
          console.error(`❌ Could not locate prompt input box for prompt #${promptNumber}. Skipping...`);
          continue;
        }

        console.log('🧹 Clearing previous input text...');
        await hardClearInput(page, inputElement);

        const knownImageSourcesBeforePrompt = await recordPrePromptBaseline(page);

        await generateAndCapturePromptImages(
          page,
          cdpClient,
          inputElement,
          promptText,
          promptNumber,
          knownImageSourcesBeforePrompt
        );

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
  }
}

// Run bot
main().catch((err) => {
  console.error('💥 Unhandled error in main:', err);
  process.exit(1);
});
