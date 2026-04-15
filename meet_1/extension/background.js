// --- Config ---
const API_ENDPOINT = "https://antinsfw-agf0habfesauhgah.southeastasia-01.azurewebsites.net/predict";
const API_KEY = "";  // Set your API key here (must match ANTINUDE_API_KEY on server)
const SCAN_INTERVAL_MS = 1000;  // Chrome allows max 2 captureVisibleTab/sec — 1s is safe
const JPEG_QUALITY = 50;
const MAX_CONSECUTIVE_ERRORS = 5;

let errorCount = 0;
let scanInterval = null;
let isProcessing = false;  // Mutex: prevent overlapping captures

// --- Capture and Analyze ---
async function captureAndAnalyze() {
    // Skip if previous capture still processing
    if (isProcessing) return;
    isProcessing = true;

    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // Skip internal Chrome pages
        if (!activeTab || !activeTab.url || activeTab.url.startsWith("chrome://")) return;

        // Capture visible tab as JPEG
        let dataUrl;
        try {
            dataUrl = await chrome.tabs.captureVisibleTab(
                activeTab.windowId,
                { format: "jpeg", quality: JPEG_QUALITY }
            );
        } catch (captureErr) {
            // Tab being dragged, devtools focused, or other transient state — skip silently
            return;
        }

        const base64Image = dataUrl.split(",")[1];

        // Build request headers
        const headers = { "Content-Type": "application/json" };
        if (API_KEY) headers["X-API-Key"] = API_KEY;

        // Send to backend
        const response = await fetch(API_ENDPOINT, {
            method: "POST",
            headers,
            body: JSON.stringify({ image_base64: base64Image }),
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const result = await response.json();
        errorCount = 0;  // Reset on success

        if (result.status === "nsfw") {
            console.warn("[Antinude] NSFW detected — sending blur signal");
            try {
                await chrome.tabs.sendMessage(activeTab.id, { action: "EXECUTE_BLUR" });
            } catch {
                // Content script not injected yet (tab was open before extension loaded)
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    files: ["content.js"],
                });
                await chrome.tabs.sendMessage(activeTab.id, { action: "EXECUTE_BLUR" });
            }
        }

    } catch (error) {
        errorCount++;
        console.error(`[Antinude] Detection failed (${errorCount}/${MAX_CONSECUTIVE_ERRORS}):`, error.message);

        // Back off if too many consecutive errors
        if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
            console.warn("[Antinude] Too many errors, pausing for 30s...");
            stopScanning();
            setTimeout(() => {
                errorCount = 0;
                startScanning();
            }, 30000);
        }
    } finally {
        isProcessing = false;
    }
}

// --- Interval-based scanning ---
function startScanning() {
    if (scanInterval) return;
    scanInterval = setInterval(captureAndAnalyze, SCAN_INTERVAL_MS);
}

function stopScanning() {
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
    }
}

chrome.runtime.onInstalled.addListener(() => {
    console.log("[Antinude] Service worker started.");
    startScanning();
});

chrome.runtime.onStartup.addListener(() => {
    startScanning();
});