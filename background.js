chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message.type !== "CLICK_SKIP_BUTTON") {
      return;
    }

    const tabId = sender.tab?.id;

    if (tabId === undefined) {
      sendResponse({
        success: false,
        error: "No tab ID"
      });

      return;
    }

    clickAtPosition(tabId, message.x, message.y)
      .then(() => {
        sendResponse({
          success: true
        });
      })
      .catch(error => {
        console.error("[Skip Extension]", error);

        sendResponse({
          success: false,
          error: error.message
        });
      });

    // Keep the message channel open for the async response.
    return true;
  }
);


async function clickAtPosition(tabId, x, y) {
  const target = { tabId };

  try {
    await chrome.debugger.attach(target, "1.3");

    await chrome.debugger.sendCommand(
      target,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse"
      }
    );

    await chrome.debugger.sendCommand(
      target,
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse"
      }
    );

  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // Ignore if Chrome already detached it.
    }
  }
}
