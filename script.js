// ===== Configuration =====
const WHATSAPP_MESSAGE = "Hello, I am Atmoratech Pvt Ltd, We provide customizable software solutions.";

// ===== DOM Elements =====
const cameraBtn = document.getElementById("cameraBtn");
const fileInput = document.getElementById("fileInput");
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
const result = document.getElementById("result");
const numbersEl = document.getElementById("numbers");
const rawTextEl = document.getElementById("rawText");

let stream = null;
let capturedImageBlob = null;

// ===== Helpers =====
function setStatus(text) {
  status.textContent = text;
  status.classList.remove("hidden");
}

function hideStatus() {
  status.classList.add("hidden");
}

// Extract phone numbers from raw OCR text
function extractPhoneNumbers(text) {
  // Remove newlines/extra spaces but keep some separators
  const cleaned = text.replace(/\s+/g, " ");

  // Match international and local phone formats
  // e.g. +91 98765 43210, +1-555-123-4567, 09876543210, (022) 12345678
  const phoneRegex =
    /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;

  const matches = cleaned.match(phoneRegex) || [];

  // Filter: must contain at least 8 digits, ignore years / random short numbers
  const filtered = matches
    .map((m) => m.trim())
    .filter((m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    })
    // Deduplicate
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return filtered;
}

// Open WhatsApp with predefined message
function openWhatsApp(number) {
  // Strip everything but digits and leading +
  let cleaned = number.replace(/[^\d+]/g, "");
  // Ensure only leading + is kept
  cleaned = cleaned.replace(/(?!^)\+/g, "");

  const url = `https://wa.me/${cleaned}?text=${encodeURIComponent(WHATSAPP_MESSAGE)}`;
  window.open(url, "_blank");
}

// ===== OCR Processing =====
async function processImage(imageSource) {
  hideStatus();
  result.classList.add("hidden");
  setStatus("🔍 Reading card... this may take a few seconds");

  try {
    const { data } = await Tesseract.recognize(imageSource, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setStatus(`🔍 Reading card... ${Math.round(m.progress * 100)}%`);
        }
      },
    });

    hideStatus();
    const text = data.text || "";
    rawTextEl.textContent = text || "(no text detected)";

    const numbers = extractPhoneNumbers(text);

    numbersEl.innerHTML = "";

    if (numbers.length === 0) {
      const div = document.createElement("div");
      div.className = "no-numbers";
      div.textContent = "No phone numbers found. Try a clearer photo.";
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
          // Visual feedback
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
  } catch (err) {
    console.error(err);
    setStatus("❌ OCR failed: " + err.message);
  }
}

// ===== Camera =====
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
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
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);

  // Stop camera
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.hidden = true;

  // Show preview
  preview.src = canvas.toDataURL("image/png");
  preview.hidden = false;

  // Reset button
  cameraBtn.textContent = "📷 Scan with Camera";
  cameraBtn.onclick = startCamera;

  // Process
  processImage(canvas);
}

// ===== File Upload =====
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

// ===== Init =====
cameraBtn.onclick = startCamera;
