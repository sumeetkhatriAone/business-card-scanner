// ===== Configuration =====
const WHATSAPP_MESSAGE = "Hello, I am Atmoratech Pvt Ltd";

// Optional: default country code for local numbers.
// Set to "" to disable. Example: "91" for India, "1" for USA.
const DEFAULT_COUNTRY_CODE = "91";

// ===== DOM =====
const cameraBtn = document.getElementById("cameraBtn");
const fileInput = document.getElementById("fileInput");
const debugBtn = document.getElementById("debugBtn");
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
const result = document.getElementById("result");
const numbersEl = document.getElementById("numbers");
const rawTextEl = document.getElementById("rawText");

let stream = null;
let lastProcessedDataUrl = null;

// ===== Helpers =====
function setStatus(text) {
  status.textContent = text;
  status.classList.remove("hidden");
}
function hideStatus() { status.classList.add("hidden"); }

// ---------------------------------------------------------------
// IMAGE PREPROCESSING
// Converts to grayscale, boosts contrast, and upscales small images.
// This dramatically improves Tesseract's digit accuracy.
// ---------------------------------------------------------------
function preprocessImage(imageSource) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Upscale if too small (Tesseract struggles under ~1000px width)
      const MIN_WIDTH = 1600;
      const scale = Math.max(1, MIN_WIDTH / img.width);

      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");

      // High quality resampling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);

      // Grayscale + contrast boost
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      // Find min/max luminance to do adaptive contrast stretch
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (g < min) min = g;
        if (g > max) max = g;
      }
      const range = Math.max(1, max - min);

      for (let i = 0; i < data.length; i += 4) {
        const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        // Stretch to full 0-255
        let v = ((g - min) / range) * 255;
        // Slight threshold toward black/white to help OCR
        v = v < 100 ? 0 : v > 180 ? 255 : v;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
      ctx.putImageData(imageData, 0, 0);

      resolve(c);
    };
    img.src = imageSource;
  });
}

// ---------------------------------------------------------------
// PHONE NUMBER EXTRACTION
// Strategy: join everything into one string, then find runs of
// characters that are digits / + / spaces / dashes / parens / dots.
// This keeps "+91 98765 43210" as ONE candidate instead of splitting.
// ---------------------------------------------------------------
function extractPhoneNumbers(text) {
  if (!text) return [];

  // Normalize common OCR digit confusions inside number-ish contexts
  // (only used for matching — we don't rewrite user display text)
  const normalized = text
    .replace(/\r/g, "\n")
    // unify different dashes
    .replace(/[–—−]/g, "-");

  // Find every plausible phone "chunk":
  // may start with + or (, contains 8–18 chars of digits/separators
  const chunkRegex = /(?:\+?\d[\d\s().\-]{6,20}\d)/g;

  const rawCandidates = normalized.match(chunkRegex) || [];
  const results = [];

  for (const raw of rawCandidates) {
    // Extract digits only
    let digits = raw.replace(/\D/g, "");

    // Sometimes OCR glues a label like "Mob" that becomes nothing,
    // but glues things like "91 98765 43210" fine here.

    // Too short? skip.
    if (digits.length < 8) continue;
    // Too long? Truncate to a plausible number (max E.164 = 15)
    if (digits.length > 15) {
      // If the chunk is way too long, it likely contains noise.
      // Try trimming leading zeros or taking the LAST 10-13 digits.
      if (digits.length > 18) continue;
      digits = digits.slice(-13);
    }

    // Remove leading zeros that are trunk prefixes (common in India: 0xxxxxxxxxx)
    // Only strip ONE leading 0
    if (digits.length === 11 && digits.startsWith("0")) {
      digits = digits.substring(1);
    }

    // Preserve + if original had one
    const hadPlus = /^\s*\+/.test(raw) || /^\s*00/.test(raw);
    let formatted = hadPlus ? "+" + digits : digits;

    // Optional: add country code for bare 10-digit numbers
    if (
      DEFAULT_COUNTRY_CODE &&
      !formatted.startsWith("+") &&
      digits.length === 10
    ) {
      formatted = "+" + DEFAULT_COUNTRY_CODE + digits;
    }

    // Deduplicate by pure digits
    const key = formatted.replace(/\D/g, "");
    if (!results.find((r) => r.replace(/\D/g, "") === key)) {
      results.push(formatted);
    }
  }

  return results;
}

// ---------------------------------------------------------------
// WHATSAPP
// ---------------------------------------------------------------
function openWhatsApp(number) {
  let digits = number.replace(/\D/g, "");

  // If no country code and we have a default, add it
  if (
    DEFAULT_COUNTRY_CODE &&
    !number.startsWith("+") &&
    digits.length === 10
  ) {
    digits = DEFAULT_COUNTRY_CODE + digits;
  }

  const url = `https://wa.me/${digits}?text=${encodeURIComponent(WHATSAPP_MESSAGE)}`;
  window.open(url, "_blank");
}

// ---------------------------------------------------------------
// OCR
// ---------------------------------------------------------------
async function processImage(imageSource) {
  hideStatus();
  result.classList.add("hidden");
  setStatus("🔍 Preparing image...");

  try {
    // 1. Preprocess
    const processedCanvas = await preprocessImage(imageSource);
    lastProcessedDataUrl = processedCanvas.toDataURL("image/png");

    // 2. Run Tesseract with digit-friendly settings
    setStatus("🔍 Reading card... 0%");

    const worker = await Tesseract.createWorker("eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setStatus(`🔍 Reading card... ${Math.round(m.progress * 100)}%`);
        }
      },
    });

    // Preserve spaces & full layout so numbers don't glue to words
    await worker.setParameters({
      tessedit_char_whitelist: "",
      tessedit_pageseg_mode: "6", // PSM 6: assume uniform block of text
      preserve_interword_spaces: "1",
    });

    const { data } = await worker.recognize(processedCanvas);
    await worker.terminate();

    hideStatus();
    const text = data.text || "";
    rawTextEl.textContent = text || "(no text detected)";

    const numbers = extractPhoneNumbers(text);
    numbersEl.innerHTML = "";

    if (numbers.length === 0) {
      const div = document.createElement("div");
      div.className = "no-numbers";
      div.innerHTML =
        "No phone numbers found.<br><small>Try a sharper photo, better lighting, or crop closer to the number.</small>";
      numbersEl.appendChild(div);
    } else {
      numbers.forEach((num) => {
        const card = document.createElement("div");
        card.className = "number-card";
        card.innerHTML = `
          <span class="number-text">${num}</span>
          <span class="wa-icon">💬</span>
        `;
        card.addEventListener("click", () => {
          document
            .querySelectorAll(".number-card")
            .forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          openWhatsApp(num);
        });
        numbersEl.appendChild(card);
      });
    }

    result.classList.remove("hidden");

    // Show debug button if OCR text is short (indicates it struggled)
    debugBtn.hidden = text.trim().length > 30;
  } catch (err) {
    console.error(err);
    setStatus("❌ OCR failed: " + err.message);
  }
}

// Debug: show the preprocessed image so you can see what Tesseract "sees"
debugBtn.addEventListener("click", () => {
  if (!lastProcessedDataUrl) return;
  const existing = document.querySelector(".debug-img");
  if (existing) existing.remove();
  const img = document.createElement("img");
  img.src = lastProcessedDataUrl;
  img.className = "debug-img";
  img.alt = "preprocessed";
  result.appendChild(img);
});

// ---------------------------------------------------------------
// CAMERA
// ---------------------------------------------------------------
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    video.hidden = false;
    preview.hidden = true;
    cameraBtn.textContent = "📸 Capture";
    cameraBtn.onclick = captureFromCamera;
  } catch (err) {
    alert("Camera error: " + err.message);
  }
}

function captureFromCamera() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.hidden = true;

  preview.src = canvas.toDataURL("image/png");
  preview.hidden = false;

  cameraBtn.textContent = "📷 Scan with Camera";
  cameraBtn.onclick = startCamera;

  processImage(canvas.toDataURL("image/png"));
}

// ---------------------------------------------------------------
// FILE UPLOAD
// ---------------------------------------------------------------
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    preview.src = ev.target.result;
    preview.hidden = false;
    processImage(ev.target.result);
  };
  reader.readAsDataURL(file);
});

// ---------------------------------------------------------------
// INIT
// ---------------------------------------------------------------
cameraBtn.onclick = startCamera;

// Toggle raw text visibility
rawTextEl.addEventListener("click", () => {
  rawTextEl.style.display =
    rawTextEl.style.display === "none" ? "block" : "none";
});
