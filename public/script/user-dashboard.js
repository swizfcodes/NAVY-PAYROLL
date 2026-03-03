// ══════════════════════════════════════════════════════════
// user-dashboard.js — unified script
// ══════════════════════════════════════════════════════════

// ── Clear payroll class on dashboard load ──────────────────
localStorage.removeItem("current_class");

// ── Encrypt/decrypt ────────────────────────────────────────
function encryptVal(val) {
  return btoa(
    val
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 3))
      .join(""),
  );
}
function decryptVal(val) {
  return atob(val)
    .split("")
    .map((c) => String.fromCharCode(c.charCodeAt(0) - 3))
    .join("");
}

// ── Helper: inject HTML + execute scripts ──────────────────
function injectWithScripts(container, html) {
  container.innerHTML = html;
  container.querySelectorAll("script").forEach(function (oldScript) {
    var newScript = document.createElement("script");
    newScript.textContent = oldScript.textContent;
    oldScript.parentNode.replaceChild(newScript, oldScript);
  });
}

// ══════════════════════════════════════════════════════════
// REAL NAME
// ══════════════════════════════════════════════════════════
var fullName = localStorage.getItem("full_name") || "Officer";

function formatDisplayName(name) {
  var parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] + " " + parts[1];
  return (
    parts[0] + " " + parts[1] + " " + parts[parts.length - 1].charAt(0) + "."
  );
}

var displayName = formatDisplayName(fullName);

var userDisplayEl = document.getElementById("user-display-name");
var headerNameEl = document.getElementById("header-username-text");
if (userDisplayEl) userDisplayEl.textContent = displayName;
if (headerNameEl) headerNameEl.textContent = fullName;

// ══════════════════════════════════════════════════════════
// TIME-BASED GREETING
// ══════════════════════════════════════════════════════════
function applyGreeting() {
  var hour = new Date().getHours();

  var greetings = {
    midnight: [
      {
        icon: "🌌",
        tag: "Midnight",
        sub: "Burning the midnight oil, Officer.",
      },
      {
        icon: "🌙",
        tag: "Still Awake?",
        sub: "Don't forget to get some rest.",
      },
      {
        icon: "⭐",
        tag: "Late Night",
        sub: "Rest up, tomorrow needs you sharp.",
      },
      {
        icon: "🔭",
        tag: "Mid-Watch",
        sub: "Keep a sharp lookout. The fleet sleeps soundly on your watch.",
      },
      {
        icon: "🔦",
        tag: "Night Ops",
        sub: "Precision and focus, even in the dark.",
      },
    ],
    morning: [
      {
        icon: "🌅",
        tag: "Good Morning",
        sub: "Duty begins with a clear mind.",
      },
      {
        icon: "☀️",
        tag: "Good Morning",
        sub: "Hope your morning is off to a great start.",
      },
      {
        icon: "☕",
        tag: "Rise & Shine",
        sub: "A good cup of coffee and a great day ahead.",
      },
      {
        icon: "🌤️",
        tag: "Good Morning",
        sub: "The early bird is already ahead of the game.",
      },
      {
        icon: "⚓",
        tag: "Anchor's Aweigh",
        sub: "New day, new objectives. Let's make headway.",
      },
      {
        icon: "🚢",
        tag: "Full Speed Ahead",
        sub: "Set the pace for the crew today, Officer.",
      },
      { icon: "🌞", tag: "Almost Noon", sub: "Keep the momentum going." },
      {
        icon: "☕",
        tag: "Coffee Hour",
        sub: "Halfway to the afternoon, you're doing great.",
      },
    ],
    afternoon: [
      {
        icon: "🌤️",
        tag: "Good Afternoon",
        sub: "A productive afternoon makes for a great evening.",
      },
      { icon: "⚓", tag: "Good Afternoon", sub: "Steady as the ship goes." },
      {
        icon: "🌞",
        tag: "Sunny Afternoon",
        sub: "Keep pushing... the finish line is in sight.",
      },
      {
        icon: "🧭",
        tag: "Steady Course",
        sub: "Your leadership is the compass of this unit.",
      },
      {
        icon: "🌊",
        tag: "Smooth Sailing",
        sub: "You've got the helm. Keep the momentum high.",
      },
      {
        icon: "🌇",
        tag: "Good Afternoon",
        sub: "Almost there... finish strong.",
      },
    ],
    evening: [
      {
        icon: "🌆",
        tag: "Good Evening",
        sub: "Time to wind down after a solid day.",
      },
      { icon: "🌙", tag: "Good Evening", sub: "Rest well — you've earned it." },
      {
        icon: "🌃",
        tag: "Wonderful Evening, Officer",
        sub: "Hope the day treated you well.",
      },
      {
        icon: "🎖️",
        tag: "Mission Success",
        sub: "Another day of service in the books. Well done.",
      },
      {
        icon: "🕯️",
        tag: "Safe Harbor",
        sub: "The day's work is done. Time to recharge.",
      },
    ],
    night: [
      {
        icon: "🌙",
        tag: "Good Night",
        sub: "Rest up, tomorrow needs you sharp.",
      },
      {
        icon: "⭐",
        tag: "Slient Night",
        sub: "Don't forget to get some rest.",
      },
      { icon: "🌌", tag: "Good Night", sub: "Time for bed, a new day awaits." },
      {
        icon: "🔕",
        tag: "Silence on Deck",
        sub: "Even the best engines need a cooldown. Sleep well.",
      },
    ],
  };

  var pool;
  if (hour >= 0 && hour < 4) pool = greetings.midnight;
  else if (hour >= 4 && hour < 12) pool = greetings.morning;
  else if (hour >= 12 && hour < 16) pool = greetings.afternoon;
  else if (hour >= 16 && hour < 21) pool = greetings.evening;
  else pool = greetings.night;

  var pick = pool[Math.floor(Math.random() * pool.length)];

  var iconEl = document.getElementById("greeting-icon");
  var textEl = document.getElementById("greeting-text");
  var subEl = document.getElementById("greeting-sub");
  if (iconEl) iconEl.textContent = pick.icon;
  if (textEl) textEl.textContent = pick.tag;
  if (subEl) subEl.textContent = pick.sub;
}

applyGreeting();
setInterval(applyGreeting, 60 * 1000);

// ══════════════════════════════════════════════════════════
// HEADER: logo ↔ username swap
// ══════════════════════════════════════════════════════════
var headerLogo = document.getElementById("header-logo");
var headerUsername = document.getElementById("header-username");

function updateHeaderSlot(pageId) {
  if (!headerLogo || !headerUsername) return;
  if (pageId === "home") {
    headerLogo.classList.remove("hidden-slot");
    headerUsername.classList.remove("visible-slot");
  } else {
    headerLogo.classList.add("hidden-slot");
    headerUsername.classList.add("visible-slot");
  }
}

// ══════════════════════════════════════════════════════════
// PAGE SWITCHER
// ══════════════════════════════════════════════════════════
function showPage(id) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll("nav a")
    .forEach((a) => a.classList.remove("active"));

  var pg = document.getElementById("page-" + id);
  var nav = document.getElementById("nav-" + id);
  if (pg) pg.classList.add("active");
  if (nav) nav.classList.add("active");

  updateHeaderSlot(id);

  // Persist the active page across refreshes
  sessionStorage.setItem("activePage", id);
}

// ══════════════════════════════════════════════════════════
// NAV LINKS
// ══════════════════════════════════════════════════════════
document.querySelectorAll("nav a[data-page]").forEach(function (link) {
  link.addEventListener("click", function (e) {
    var page = this.getAttribute("data-page");

    if (page === "logout") {
      e.preventDefault();
      confirmLogout();
      return;
    }

    if (page === "payroll") {
      e.preventDefault();
      var currentClass = localStorage.getItem("current_class");
      if (currentClass) {
        window.location.href = "/dashboard.html";
      } else {
        if (typeof window.openPayrollModal === "function")
          window.openPayrollModal();
      }
      return;
    }

    e.preventDefault();
    if (page === "email") loadEmailPage();
    showPage(page);
  });
});

// Quick action buttons on home page
document.querySelectorAll("button[data-page]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var page = this.getAttribute("data-page");
    if (page === "email") loadEmailPage();
    showPage(page);
  });
});

// ══════════════════════════════════════════════════════════
// RESTORE PAGE ON REFRESH
// Reads the page saved in sessionStorage and navigates back to it.
// sessionStorage survives a refresh but is cleared on tab close /
// logout, so it never leaks into a fresh login.
// ══════════════════════════════════════════════════════════
(function restoreActivePage() {
  var saved = sessionStorage.getItem("activePage");
  if (saved && saved !== "home") {
    if (saved === "email") loadEmailPage();
    showPage(saved);
  }
})();

// ══════════════════════════════════════════════════════════
// EMAIL — lazy load
// ══════════════════════════════════════════════════════════
var emailPageLoaded = false;

function loadEmailPage() {
  if (emailPageLoaded) return;
  fetch("pages/email.html")
    .then((r) => r.text())
    .then(function (html) {
      injectWithScripts(document.getElementById("page-email"), html);
      emailPageLoaded = true;
    })
    .catch(function () {
      document.getElementById("page-email").innerHTML =
        '<p style="color:rgba(200,220,255,0.4);padding:40px;">Failed to load mailbox. Please refresh.</p>';
    });
}

// ══════════════════════════════════════════════════════════
// GLOBAL EMAIL BADGE + VIBRATE — runs on every page, always
// ══════════════════════════════════════════════════════════
var _globalLastUnread = -1;
var _globalPollTimer = null;

function vibrateEmailTargets() {
  var navEmail = document.getElementById("nav-email");
  if (navEmail) {
    navEmail.classList.remove("nav-vibrate");
    void navEmail.offsetWidth;
    navEmail.classList.add("nav-vibrate");
    navEmail.addEventListener(
      "animationend",
      function () {
        navEmail.classList.remove("nav-vibrate");
      },
      { once: true },
    );
  }

  var emailBtn = document.querySelector('button[data-page="email"]');
  if (emailBtn) {
    emailBtn.classList.remove("nav-vibrate");
    void emailBtn.offsetWidth;
    emailBtn.classList.add("nav-vibrate");
    emailBtn.addEventListener(
      "animationend",
      function () {
        emailBtn.classList.remove("nav-vibrate");
      },
      { once: true },
    );
  }
}

function updateGlobalBadge(count) {
  var isIncrease = _globalLastUnread >= 0 && count > _globalLastUnread;
  _globalLastUnread = count;

  // ── Nav badge ──
  var navEmail = document.getElementById("nav-email");
  if (navEmail) {
    var navBadge = document.getElementById("nav-mail-badge");
    if (!navBadge) {
      navBadge = document.createElement("span");
      navBadge.id = "nav-mail-badge";
      navBadge.style.cssText =
        "background:#f5c842;color:#0d1f35;font-size:10px;font-weight:700;" +
        "padding:2px 6px;border-radius:20px;margin-left:6px;" +
        "vertical-align:middle;display:none";
      navEmail.appendChild(navBadge);
    }
    navBadge.textContent = count > 99 ? "99+" : count;
    navBadge.style.display = count > 0 ? "inline-block" : "none";
  }

  // ── Home quick-action button badge ──
  var emailBtn = document.querySelector('button[data-page="email"]');
  if (emailBtn) {
    var btnBadge = document.getElementById("home-email-btn-badge");
    if (!btnBadge) {
      emailBtn.style.position = "relative";
      btnBadge = document.createElement("span");
      btnBadge.id = "home-email-btn-badge";
      btnBadge.style.cssText =
        "position:absolute;top:-8px;right:-8px;" +
        "background:#f5c842;color:#0d1f35;font-size:10px;font-weight:700;" +
        "padding:2px 6px;border-radius:20px;min-width:18px;text-align:center;" +
        "box-shadow:0 2px 8px rgba(0,0,0,0.3);pointer-events:none;display:none;";
      emailBtn.appendChild(btnBadge);
    }
    btnBadge.textContent = count > 99 ? "99+" : count;
    btnBadge.style.display = count > 0 ? "inline-block" : "none";
  }

  // ── Email page inbox tab badge (if loaded) ──
  var inboxBadge = document.getElementById("inbox-badge");
  if (inboxBadge) {
    inboxBadge.textContent = count > 99 ? "99+" : count;
    count > 0
      ? inboxBadge.classList.add("visible")
      : inboxBadge.classList.remove("visible");
  }

  if (isIncrease) vibrateEmailTargets();
}

function startGlobalEmailPolling() {
  var token = localStorage.getItem("token");
  if (!token || _globalPollTimer) return;

  (function poll() {
    fetch("/messages/inbox?page=1&limit=1", {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    })
      .then((r) => r.json())
      .then(function (data) {
        if (data.unread === undefined) return;
        var prev = _globalLastUnread;
        updateGlobalBadge(data.unread);
        if (prev >= 0 && data.unread > prev && emailPageLoaded) {
          document.dispatchEvent(new CustomEvent("globalNewMail"));
        }
      })
      .catch(function () {});
  })();

  _globalPollTimer = setInterval(function () {
    var t = localStorage.getItem("token");
    if (!t) return;
    fetch("/messages/inbox?page=1&limit=1", {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + t,
      },
    })
      .then((r) => r.json())
      .then(function (data) {
        if (data.unread === undefined) return;
        var prev = _globalLastUnread;
        updateGlobalBadge(data.unread);
        if (prev >= 0 && data.unread > prev && emailPageLoaded) {
          document.dispatchEvent(new CustomEvent("globalNewMail"));
        }
      })
      .catch(function () {});
  }, 10000);
}

startGlobalEmailPolling();

// ══════════════════════════════════════════════════════════
// ALERT MODAL
// ══════════════════════════════════════════════════════════
const DashAlertModal = {
  modal: null,

  init() {
    const el = document.createElement("div");
    el.id = "dashAlert";
    el.style.cssText = `
      position:fixed;inset:0;background:rgba(4,12,28,0.82);
      backdrop-filter:blur(6px);display:flex;align-items:center;
      justify-content:center;z-index:300;opacity:0;pointer-events:none;
      transition:opacity 0.25s ease;
    `;
    el.innerHTML = `
      <div style="background:#0f2340;border:1px solid rgba(255,255,255,0.10);
        border-radius:14px;padding:36px 40px;max-width:380px;width:100%;
        text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.5);">
        <p id="dashAlertMsg" style="font-family:'DM Sans',sans-serif;font-size:14px;
          color:rgba(200,220,255,0.85);margin-bottom:24px;line-height:1.6;"></p>
        <button id="dashAlertOk" style="padding:11px 32px;background:#f5c842;
          color:#0d1f35;font-family:'DM Sans',sans-serif;font-size:14px;
          font-weight:600;border:none;border-radius:8px;cursor:pointer;">OK</button>
      </div>
    `;
    document.body.appendChild(el);
    this.modal = el;
    document
      .getElementById("dashAlertOk")
      .addEventListener("click", () => this.close());
  },

  confirm(
    message,
    onConfirm,
    onCancel,
    confirmLabel = "Delete",
    confirmDanger = true,
  ) {
    document.getElementById("dashAlertMsg").textContent = message;
    const okBtn = document.getElementById("dashAlertOk");
    const wrapper = okBtn.parentNode;

    okBtn.textContent = confirmLabel;
    okBtn.style.background = confirmDanger ? "#e74c3c" : "#f5c842";
    okBtn.style.color = confirmDanger ? "#fff" : "#0d1f35";
    okBtn.style.marginRight = "12px";
    okBtn.onclick = () => {
      this.close();
      if (onConfirm) onConfirm();
    };

    let cancelBtn = document.getElementById("dashAlertCancel");
    if (!cancelBtn) {
      cancelBtn = document.createElement("button");
      cancelBtn.id = "dashAlertCancel";
      cancelBtn.style.cssText =
        "padding:11px 32px;background:transparent;color:rgba(200,220,255,0.7);" +
        "font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;" +
        "border:1px solid rgba(200,220,255,0.3);border-radius:8px;cursor:pointer;";
      wrapper.appendChild(cancelBtn);
      cancelBtn.addEventListener("click", () => {
        this.close();
        if (onCancel) onCancel();
      });
    }
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.display = "inline-block";

    this.modal.style.opacity = "1";
    this.modal.style.pointerEvents = "all";
  },

  show(message) {
    document.getElementById("dashAlertMsg").textContent = message;
    const okBtn = document.getElementById("dashAlertOk");
    const cancelBtn = document.getElementById("dashAlertCancel");
    okBtn.textContent = "OK";
    okBtn.style.background = "#f5c842";
    okBtn.style.color = "#0d1f35";
    okBtn.style.marginRight = "0";
    okBtn.onclick = () => this.close();
    if (cancelBtn) cancelBtn.style.display = "none";
    this.modal.style.opacity = "1";
    this.modal.style.pointerEvents = "all";
  },

  close() {
    this.modal.style.opacity = "0";
    this.modal.style.pointerEvents = "none";
  },
};

DashAlertModal.init();

// ══════════════════════════════════════════════════════════
// LOGOUT — confirm modal, then wipe session
// ══════════════════════════════════════════════════════════

function confirmLogout() {
  // Build the modal once, reuse on subsequent calls
  var overlay = document.getElementById("logoutConfirmModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "logoutConfirmModal";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(4,12,28,0.82);" +
      "backdrop-filter:blur(6px);display:flex;align-items:center;" +
      "justify-content:center;z-index:400;opacity:0;pointer-events:none;" +
      "transition:opacity 0.25s ease;";
    overlay.innerHTML = `
      <div id="logoutConfirmBox" style="background:#0f2340;
        border:1px solid rgba(255,255,255,0.10);border-radius:16px;
        padding:40px 44px;max-width:360px;width:100%;text-align:center;
        box-shadow:0 32px 80px rgba(0,0,0,0.6);
        transform:translateY(12px);transition:transform 0.25s ease;">
        <div style="font-size:38px;margin-bottom:14px;">🔒</div>
        <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;
          font-weight:700;color:#fff;margin-bottom:8px;">Sign Out?</p>
        <p style="font-family:'DM Sans',sans-serif;font-size:13px;
          color:rgba(200,220,255,0.5);margin-bottom:32px;line-height:1.7;">
          You'll need to sign in again<br>to access your account.
        </p>
        <div style="display:flex;gap:12px;">
          <button id="logoutCancelBtn"
            style="flex:1;padding:13px;background:transparent;
              color:rgba(200,220,255,0.7);font-family:'DM Sans',sans-serif;
              font-size:14px;font-weight:600;
              border:1px solid rgba(200,220,255,0.2);border-radius:8px;
              cursor:pointer;transition:all 0.2s;">
            Cancel
          </button>
          <button id="logoutConfirmBtn"
            style="flex:1;padding:13px;background:#e74c3c;color:#fff;
              font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;
              border:none;border-radius:8px;cursor:pointer;transition:all 0.2s;">
            Sign Out
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Hover effects
    var cancelBtn = document.getElementById("logoutCancelBtn");
    var confirmBtn = document.getElementById("logoutConfirmBtn");

    cancelBtn.addEventListener("mouseenter", function () {
      this.style.background = "rgba(255,255,255,0.06)";
      this.style.borderColor = "rgba(200,220,255,0.4)";
      this.style.color = "#fff";
    });
    cancelBtn.addEventListener("mouseleave", function () {
      this.style.background = "transparent";
      this.style.borderColor = "rgba(200,220,255,0.2)";
      this.style.color = "rgba(200,220,255,0.7)";
    });
    confirmBtn.addEventListener("mouseenter", function () {
      this.style.background = "#c0392b";
    });
    confirmBtn.addEventListener("mouseleave", function () {
      this.style.background = "#e74c3c";
    });

    // Close on Cancel
    cancelBtn.addEventListener("click", function () {
      _closeLogoutModal(overlay);
    });

    // Close on backdrop click
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) _closeLogoutModal(overlay);
    });

    // Confirm logout
    confirmBtn.addEventListener("click", function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Logging out...";
      //_closeLogoutModal(overlay);
      logout();
    });
  }

  // Show
  overlay.style.opacity = "1";
  overlay.style.pointerEvents = "all";
  var box = document.getElementById("logoutConfirmBox");
  if (box) box.style.transform = "translateY(0)";
}

function _closeLogoutModal(overlay) {
  overlay.style.opacity = "0";
  overlay.style.pointerEvents = "none";
  var box = document.getElementById("logoutConfirmBox");
  if (box) box.style.transform = "translateY(12px)";
}

function logout() {
  // Clear sessionStorage first so activePage doesn't survive into next login
  sessionStorage.clear();
  localStorage.clear();
  window.location.href = "personnel-user-login.html";
}

// ══════════════════════════════════════════════════════════
// PAYROLL MODAL — load + handle payroll return from logout
// ══════════════════════════════════════════════════════════
fetch("pages/payroll-modal.html")
  .then((r) => r.text())
  .then(function (html) {
    var container = document.createElement("div");
    document.body.appendChild(container);
    injectWithScripts(container, html);

    if (
      sessionStorage.getItem("_pid") &&
      sessionStorage.getItem("_from_logout")
    ) {
      sessionStorage.removeItem("_from_logout");
      window.openPayrollModal();
    }
  })
  .catch((err) => console.error("Failed to load payroll modal:", err));
