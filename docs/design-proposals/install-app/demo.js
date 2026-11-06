(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const storageKey = "ez.installProposal.v2.lastShownDay";
  const safeRead = (storage, key) => { try { return window[storage].getItem(key); } catch { return null; } };
  const safeWrite = (storage, key, value) => { try { window[storage].setItem(key, value); } catch { /* Demo works without browser storage. */ } };
  const safeRemove = (storage, key) => { try { window[storage].removeItem(key); } catch { /* Storage is optional. */ } };
  const toast = (message) => {
    const el = document.getElementById("demo-toast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => { el.hidden = true; }, 3800);
  };

  if (document.body.dataset.page === "events") {
    const prompt = document.getElementById("install-prompt");
    const announcement = document.getElementById("announcement");
    const dayFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const calendarDay = () => {
      const parts = dayFormatter.formatToParts(new Date());
      const part = type => parts.find(value => value.type === type).value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
    // A new document is a new visit; midnight alone must not reopen the popup.
    const visitDay = calendarDay();
    let elapsed = 0;
    let lastTick = performance.now();
    let interacted = false;
    let shown = safeRead("localStorage", storageKey) === visitDay;
    const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const blocked = () => document.visibilityState !== "visible" || Boolean(document.querySelector("dialog[open]")) || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
    const suppressed = () => safeRead("localStorage", storageKey) === visitDay;
    function show(force = false) {
      if (shown || (!force && (calendarDay() !== visitDay || suppressed() || standalone() || blocked()))) return;
      shown = true;
      if (!force) safeWrite("localStorage", storageKey, visitDay);
      prompt.hidden = false;
      prompt.classList.add("enter");
      announcement.textContent = "Instaliraj EventZeka App. Uputstvo za instalaciju je dostupno ispod sadržaja.";
    }
    function dismiss() {
      const hadFocus = prompt.contains(document.activeElement);
      prompt.hidden = true;
      announcement.textContent = "Predlog je zatvoren. Uputstvo je dostupno preko linka EventZeka App.";
      if (hadFocus) {
        const link = document.querySelector(".text-link");
        (link.offsetParent ? link : document.querySelector(".profile-link")).focus();
      }
    }
    ["pointerdown", "keydown", "scroll"].forEach(type => document.addEventListener(type, () => { interacted = true; }, { passive: true }));
    document.addEventListener("visibilitychange", () => { lastTick = performance.now(); });
    window.addEventListener("storage", event => {
      if (event.key === storageKey && event.newValue === visitDay) {
        shown = true;
        prompt.hidden = true;
        announcement.textContent = "Predlog je već prikazan danas. Uputstvo je dostupno preko linka EventZeka App.";
      }
    });
    setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === "visible") elapsed += Math.min(now - lastTick, 1000);
      lastTick = now;
      if (elapsed >= 10000 && interacted) show();
    }, 200);
    document.getElementById("dismiss-x").addEventListener("click", dismiss);
    document.getElementById("dismiss-later").addEventListener("click", dismiss);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !prompt.hidden) dismiss(); });
    document.getElementById("replay").addEventListener("click", () => {
      safeRemove("localStorage", storageKey);
      prompt.hidden = true;
      prompt.classList.remove("enter");
      elapsed = 0;
      lastTick = performance.now();
      interacted = true;
      shown = false;
      toast("Novi poziv će se pojaviti za 10 sekundi aktivnog pregleda.");
    });
    if (params.get("preview") === "prompt") { shown = false; show(true); }
    document.querySelectorAll(".day").forEach(day => day.addEventListener("click", () => {
      document.querySelectorAll(".day").forEach(el => el.classList.remove("active"));
      day.classList.add("active");
      toast("Demo: izbor datuma ne učitava stvarne događaje.");
    }));
    let category = "all";
    const search = document.getElementById("event-search");
    const filter = () => {
      let count = 0;
      document.querySelectorAll(".event-row").forEach(row => {
        row.hidden = (category !== "all" && row.dataset.kind !== category) || !row.textContent.toLocaleLowerCase("sr-Latn").includes(search.value.toLocaleLowerCase("sr-Latn"));
        if (!row.hidden) count++;
      });
      document.querySelector(".empty-message").hidden = count > 0;
    };
    search.addEventListener("input", filter);
    document.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", () => {
      category = button.dataset.category;
      document.querySelectorAll("[data-category]").forEach(el => el.classList.toggle("selected", el === button));
      filter();
    }));
    document.querySelectorAll(".save").forEach(button => button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      toast("Sačuvano samo u ovom demo prikazu.");
    }));
    document.querySelectorAll("[data-demo-nav]").forEach(button => button.addEventListener("click", () => toast("Ovo je samo prikaz poziva. Pravi " + button.textContent.trim() + " ostaje u aplikaciji.")));
  }

  if (document.body.dataset.page === "guide") {
    const tabs = Array.from(document.querySelectorAll("[data-platform]"));
    function activate(platform, focus = false) {
      if (!tabs.some(tab => tab.dataset.platform === platform)) platform = "ios";
      tabs.forEach(tab => {
        const selected = tab.dataset.platform === platform;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        document.getElementById("platform-" + tab.dataset.platform).hidden = !selected;
        if (selected && focus) tab.focus();
      });
    }
    const ua = navigator.userAgent;
    const detected = /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "ios" : "desktop";
    activate(params.get("platform") || detected);
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activate(tab.dataset.platform));
      tab.addEventListener("keydown", event => {
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); activate(tabs[next].dataset.platform, true); }
      });
    });
  }
})();
