"use strict";

document.addEventListener("submit", (event) => {
  const message = event.target.dataset.confirm;
  if (message && !window.confirm(message)) {
    event.preventDefault();
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-generate-password]");
  if (!button) {
    return;
  }
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const input = button.parentElement.querySelector("input");
  input.value = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  input.select();
});

const liveKey = "quiztool-admin-live";
const liveToggle = document.getElementById("live-toggle");

function readLive() {
  try {
    return localStorage.getItem(liveKey) === "on";
  } catch {
    return false;
  }
}

function writeLive(on) {
  try {
    localStorage.setItem(liveKey, on ? "on" : "off");
  } catch {
    // Storage can be blocked; the toggle then lasts for this page only.
  }
}

function busy() {
  const active = document.activeElement;
  const typing = active && active.matches("input, select, textarea") && active.closest("[data-live]");
  const openDetails = document.querySelector("[data-live] details[open]");
  return document.hidden || typing || openDetails || String(window.getSelection()).length > 0;
}

async function refreshLive() {
  if (!liveToggle.checked || busy()) {
    return;
  }
  const response = await fetch(location.href, { headers: { "X-Live": "1" } });
  if (!response.ok) {
    return;
  }
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  for (const region of document.querySelectorAll("[data-live][id]")) {
    const fresh = next.getElementById(region.id);
    if (fresh) {
      region.replaceWith(fresh);
    }
  }
}

if (liveToggle) {
  liveToggle.checked = readLive();
  liveToggle.addEventListener("change", () => {
    writeLive(liveToggle.checked);
    refreshLive();
  });
  setInterval(() => refreshLive().catch(() => {}), 5000);
}
