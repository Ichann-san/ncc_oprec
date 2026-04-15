let isOverlayActive = false;
let tamperObserver = null;

// Listen for blur commands from background script
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "EXECUTE_BLUR") {
        applyCensorship();
    }
});

/**
 * Creates a fullscreen blur overlay with a warning popup.
 * Prevents duplicate overlays if one already exists.
 */
function applyCensorship() {
    if (document.getElementById("nsfw-blur-overlay")) return;

    isOverlayActive = true;

    // Fullscreen backdrop blur overlay
    const overlay = document.createElement("div");
    overlay.id = "nsfw-blur-overlay";
    Object.assign(overlay.style, {
        position: "fixed", top: "0", left: "0",
        width: "100vw", height: "100vh",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(20px)",
        zIndex: "2147483647",
        display: "flex", justifyContent: "center", alignItems: "center",
        fontFamily: "Arial, sans-serif",
        pointerEvents: "all",
    });

    // Warning popup box
    const popupBox = document.createElement("div");
    Object.assign(popupBox.style, {
        backgroundColor: "#ffffff",
        padding: "30px 40px",
        borderRadius: "8px",
        boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
        textAlign: "center",
        color: "#333",
        position: "relative",
        maxWidth: "400px",
    });

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.innerText = "\u2715";
    Object.assign(closeBtn.style, {
        position: "absolute", top: "12px", right: "15px",
        background: "none", border: "none",
        fontSize: "20px", cursor: "pointer", color: "#888",
        padding: "0",
    });
    closeBtn.onmouseover = () => (closeBtn.style.color = "#333");
    closeBtn.onmouseout = () => (closeBtn.style.color = "#888");
    closeBtn.onclick = () => {
        isOverlayActive = false;
        overlay.remove();
    };

    // Title
    const title = document.createElement("h2");
    title.innerText = "Access Restricted";
    Object.assign(title.style, {
        margin: "0 0 10px 0", fontSize: "1.5rem", color: "#d9534f",
    });

    // Description
    const desc = document.createElement("p");
    desc.innerText = "Potentially inappropriate content has been detected on this page. The screen has been blurred for your safety.";
    Object.assign(desc.style, {
        margin: "0", fontSize: "1rem", color: "#555", lineHeight: "1.5",
    });

    // Assemble elements
    popupBox.appendChild(closeBtn);
    popupBox.appendChild(title);
    popupBox.appendChild(desc);
    overlay.appendChild(popupBox);
    document.body.appendChild(overlay);

    // Protect overlay from tampering via DevTools
    setupAntiTampering();
}

/**
 * Watches for DOM mutations that try to remove or hide the overlay.
 * Re-applies censorship if the overlay is removed while still active.
 */
function setupAntiTampering() {
    if (tamperObserver) return;

    tamperObserver = new MutationObserver((mutations) => {
        if (!isOverlayActive) return;

        mutations.forEach((mutation) => {
            // Re-apply if overlay was removed from DOM
            mutation.removedNodes.forEach((node) => {
                if (node.id === "nsfw-blur-overlay") {
                    tamperObserver.disconnect();
                    tamperObserver = null;
                    isOverlayActive = false;
                    applyCensorship();
                }
            });

            // Restore visibility if CSS was tampered with
            if (mutation.type === "attributes" && mutation.target.id === "nsfw-blur-overlay") {
                const style = mutation.target.style;
                if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                    style.display = "flex";
                    style.visibility = "visible";
                    style.opacity = "1";
                }
            }
        });
    });

    tamperObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
    });
}