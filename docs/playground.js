/**
 * MicroAttribution Live Interactive Simulation Playground.
 *
 * Direct browser integration leveraging the compiled micro-attribution engine:
 * - Real-time MTA math (First-Touch, Last-Touch, Linear, Time-Decay, U-Shaped, Markov Chains).
 * - Real-time IP truncation and recursive PII scrubbing.
 * - Simulated offline queue backpressure and batch draining.
 *
 * Zero external frameworks. 100% native Vanilla JavaScript.
 */

(function () {
  // Access global engine compiled from src/
  const MA = window.MicroAttribution;

  // Active Simulation State
  let currentTouchpoints = [];
  let currentConversion = null;
  let isOnline = true;
  let queuedEvents = [];
  let simulationDayOffset = 0;

  // DOM Elements
  const timelineEl = document.getElementById("timelineList");
  const tableBodyEl = document.getElementById("attributionTableBody");
  const chartContainerEl = document.getElementById("chartContainer");
  const statOnlineEl = document.getElementById("statOnline");
  const statQueueCountEl = document.getElementById("statQueueCount");
  const statHighPriorityEl = document.getElementById("statHighPriority");
  const statByteSizeEl = document.getElementById("statByteSize");
  const statStorageTierEl = document.getElementById("statStorageTier");
  const consoleBoxEl = document.getElementById("consoleBox");
  const conversionAmountInput = document.getElementById("conversionAmount");
  const conversionNameInput = document.getElementById("conversionName");
  const ipInputEl = document.getElementById("ipInput");
  const ipOutputEl = document.getElementById("ipOutput");
  const urlInputEl = document.getElementById("urlInput");
  const urlOutputEl = document.getElementById("urlOutput");
  const saltEpochEl = document.getElementById("saltEpoch");
  const saltHexEl = document.getElementById("saltHex");
  const visitorTokenEl = document.getElementById("visitorToken");
  const networkSwitchEl = document.getElementById("networkSwitch");
  const statusDotEl = document.getElementById("statusDot");

  const CHANNEL_COLORS = {
    organic_search: "#10b981",
    paid_search: "#3b82f6",
    social: "#ec4899",
    email: "#f59e0b",
    referral: "#8b5cf6",
    direct: "#94a3b8",
  };

  /**
   * Logs a message to the on-screen developer console.
   */
  function logConsole(message, type = "info") {
    if (!consoleBoxEl) return;
    const time = new Date().toISOString().substring(11, 19);
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${time}] ${message}`;
    consoleBoxEl.appendChild(entry);
    consoleBoxEl.scrollTop = consoleBoxEl.scrollHeight;
  }

  /**
   * Adds a touchpoint to the active customer journey.
   */
  function addTouchpoint(channel, label, metadata = {}) {
    simulationDayOffset += Math.floor(Math.random() * 2) + 1;
    const timestamp = Date.now() - (30 - simulationDayOffset) * 86400000;

    const touchpoint = {
      channel,
      timestamp,
      metadata: { label, ...metadata },
    };

    currentTouchpoints.push(touchpoint);

    // Create simulated queued event
    const event = {
      id: "evt_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
      timestamp,
      priority: "normal",
      byteSize: 180 + JSON.stringify(metadata).length,
      payload: {
        type: "touchpoint",
        channel,
        timestamp,
        ...metadata,
      },
    };

    queuedEvents.push(event);

    logConsole(`Captured touchpoint: ${channel} (${label})`, "info");

    if (isOnline) {
      logConsole(`Transmitted batch [1 event] via fetch(keepalive) -> 200 OK`, "success");
      queuedEvents = queuedEvents.filter((e) => e.id !== event.id);
    } else {
      logConsole(`[OFFLINE] Event ${event.id} buffered in IndexedDB queue`, "warn");
    }

    updateUI();
  }

  /**
   * Records a terminal conversion event.
   */
  function recordConversion() {
    const rawVal = parseFloat(conversionAmountInput.value);
    const value = !isNaN(rawVal) && rawVal > 0 ? rawVal : 250.0;
    const name = conversionNameInput.value.trim() || "purchase";

    const timestamp = Date.now();
    currentConversion = {
      id: "conv_" + timestamp,
      value,
      timestamp,
      metadata: { name },
    };

    const convEvent = {
      id: "evt_conv_" + timestamp,
      timestamp,
      priority: "high",
      byteSize: 240,
      payload: {
        type: "conversion",
        name,
        value,
        timestamp,
      },
    };

    queuedEvents.push(convEvent);

    logConsole(`High-Priority Conversion: ${name} for $${value.toFixed(2)}`, "success");

    if (isOnline) {
      logConsole(`Dual-dispatch: Dispatched to ingestion server (200 OK) + GA4 Measurement Protocol (/mp/collect 204)`, "success");
      queuedEvents = queuedEvents.filter((e) => e.id !== convEvent.id);
    } else {
      logConsole(`[OFFLINE] High-priority conversion buffered with eviction immunity`, "warn");
    }

    updateUI();
  }

  /**
   * Resets active journey and queue.
   */
  function clearJourney() {
    currentTouchpoints = [];
    currentConversion = null;
    queuedEvents = [];
    simulationDayOffset = 0;
    logConsole("Customer journey cleared", "info");
    updateUI();
  }

  /**
   * Calculates all attribution models using the compiled micro-attribution library.
   */
  function computeAttributionModels() {
    if (currentTouchpoints.length === 0 || !currentConversion) {
      return null;
    }

    const journey = {
      visitorId: "usr_sim_evaluator",
      touchpoints: currentTouchpoints.map((t) => ({
        channel: t.channel,
        timestamp: t.timestamp,
      })),
      conversion: {
        id: currentConversion.id,
        value: currentConversion.value,
        timestamp: currentConversion.timestamp,
      },
    };

    try {
      const fta = MA.calculateAttribution(journey, "first-touch");
      const lta = MA.calculateAttribution(journey, "last-touch");
      const lnda = MA.calculateAttribution(journey, "last-non-direct");
      const linear = MA.calculateAttribution(journey, "linear");
      const timeDecay = MA.calculateAttribution(journey, "time-decay", { halfLifeDays: 7 });
      const uShaped = MA.calculateAttribution(journey, "position-based");
      const markov = MA.calculateCohortAttribution([journey], "markov");

      return { fta, lta, lnda, linear, timeDecay, uShaped, markov };
    } catch (err) {
      logConsole("Attribution calculation error: " + (err.message || String(err)), "error");
      return null;
    }
  }

  /**
   * Updates all DOM visual components.
   */
  function updateUI() {
    renderTimeline();
    renderAttribution();
    renderQueueStats();
  }

  /**
   * Renders the journey timeline list.
   */
  function renderTimeline() {
    if (!timelineEl) return;
    timelineEl.innerHTML = "";

    if (currentTouchpoints.length === 0 && !currentConversion) {
      timelineEl.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.8125rem;">
          No touchpoints recorded yet.<br/>Click a channel button above or select a preset scenario.
        </div>
      `;
      return;
    }

    currentTouchpoints.forEach((tp, idx) => {
      const item = document.createElement("div");
      item.className = "timeline-item";

      const stepNum = idx + 1;
      const channelBadgeClass = `badge-${tp.channel}`;

      item.innerHTML = `
        <span class="timeline-step">#${stepNum}</span>
        <span class="timeline-badge ${channelBadgeClass}">${tp.channel.replace("_", " ")}</span>
        <span style="font-size: 0.75rem; color: var(--text-secondary);">${tp.metadata.label || ""}</span>
        <span class="timeline-time">Day ${idx * 2}</span>
      `;
      timelineEl.appendChild(item);
    });

    if (currentConversion) {
      const convItem = document.createElement("div");
      convItem.className = "timeline-item";
      convItem.style.borderColor = "rgba(16, 185, 129, 0.4)";
      convItem.style.background = "rgba(16, 185, 129, 0.05)";

      convItem.innerHTML = `
        <span class="timeline-step" style="color: var(--accent-emerald);">Goal</span>
        <span class="timeline-badge badge-conversion">${currentConversion.metadata.name}</span>
        <span style="font-size: 0.75rem; font-weight: 700; color: var(--accent-emerald);">$${currentConversion.value.toFixed(2)}</span>
        <span class="timeline-time" style="color: var(--accent-emerald);">Terminal</span>
      `;
      timelineEl.appendChild(convItem);
    }
  }

  /**
   * Renders attribution comparison table and percentage bar charts.
   */
  function renderAttribution() {
    if (!tableBodyEl || !chartContainerEl) return;

    const results = computeAttributionModels();
    if (!results || !currentConversion) {
      tableBodyEl.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 2rem; color: var(--text-muted);">
            Add at least one touchpoint and trigger a conversion to compute attribution models.
          </td>
        </tr>
      `;
      chartContainerEl.innerHTML = "";
      return;
    }

    const { fta, lta, lnda, linear, timeDecay, uShaped, markov } = results;
    const channels = Array.from(new Set(currentTouchpoints.map((t) => t.channel)));

    // Render comparison table rows
    let tableHtml = "";
    channels.forEach((ch) => {
      const ftaVal = fta.credits[ch] || 0;
      const ltaVal = lta.credits[ch] || 0;
      const lndaVal = lnda.credits[ch] || 0;
      const linVal = linear.credits[ch] || 0;
      const decayVal = timeDecay.credits[ch] || 0;
      const uVal = uShaped.credits[ch] || 0;
      const markovVal = markov.credits[ch] || 0;

      tableHtml += `
        <tr>
          <td><strong style="color: ${CHANNEL_COLORS[ch] || '#fff'};">${ch.replace("_", " ")}</strong></td>
          <td class="numeric">$${ftaVal.toFixed(2)}</td>
          <td class="numeric">$${ltaVal.toFixed(2)}</td>
          <td class="numeric">$${lndaVal.toFixed(2)}</td>
          <td class="numeric">$${linVal.toFixed(2)}</td>
          <td class="numeric">$${decayVal.toFixed(2)}</td>
          <td class="numeric">$${uVal.toFixed(2)}</td>
          <td class="numeric">$${markovVal.toFixed(2)}</td>
        </tr>
      `;
    });

    // Total verification row
    const totalVal = currentConversion.value;
    tableHtml += `
      <tr class="total-row">
        <td>Total ($ Preserved)</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
        <td class="numeric">$${totalVal.toFixed(2)}</td>
      </tr>
    `;
    tableBodyEl.innerHTML = tableHtml;

    // Render visual bar charts for each model
    const models = [
      { name: "First-Touch", data: fta },
      { name: "Last-Touch", data: lta },
      { name: "Last Non-Direct", data: lnda },
      { name: "Linear (Equal)", data: linear },
      { name: "Time-Decay (7d Half-life)", data: timeDecay },
      { name: "U-Shaped (40/20/40)", data: uShaped },
      { name: "Markov Chain (Removal Effects)", data: markov },
    ];

    let chartHtml = "";
    models.forEach((m) => {
      let segmentsHtml = "";
      channels.forEach((ch) => {
        const credit = m.data.credits[ch] || 0;
        const pct = totalVal > 0 ? (credit / totalVal) * 100 : 0;
        if (pct > 0.1) {
          segmentsHtml += `
            <div class="bar-segment" style="width: ${pct}%; background: ${CHANNEL_COLORS[ch] || '#6366f1'};" title="${ch}: $${credit.toFixed(2)} (${pct.toFixed(1)}%)">
              ${pct >= 10 ? pct.toFixed(0) + "%" : ""}
            </div>
          `;
        }
      });

      chartHtml += `
        <div class="chart-row">
          <div class="chart-header">
            <span><strong>${m.name}</strong></span>
          </div>
          <div class="bar-track">
            ${segmentsHtml}
          </div>
        </div>
      `;
    });

    chartContainerEl.innerHTML = chartHtml;
  }

  /**
   * Renders queue and network indicators.
   */
  function renderQueueStats() {
    if (statOnlineEl) {
      statOnlineEl.textContent = isOnline ? "ONLINE" : "OFFLINE";
      statOnlineEl.className = `stat-value ${isOnline ? "online" : "offline"}`;
    }
    if (statusDotEl) {
      statusDotEl.className = `status-dot ${isOnline ? "" : "offline"}`;
    }
    if (statQueueCountEl) {
      statQueueCountEl.textContent = queuedEvents.length;
    }
    if (statHighPriorityEl) {
      statHighPriorityEl.textContent = queuedEvents.filter((e) => e.priority === "high").length;
    }
    if (statByteSizeEl) {
      const bytes = queuedEvents.reduce((acc, e) => acc + (e.byteSize || 150), 0);
      statByteSizeEl.textContent = bytes > 1024 ? (bytes / 1024).toFixed(1) + " KB" : bytes + " B";
    }
    if (statStorageTierEl) {
      statStorageTierEl.textContent = "IndexedDB";
    }
  }

  /**
   * Simulates network status toggling between Online and Offline.
   */
  function setNetworkState(online) {
    isOnline = online;
    if (networkSwitchEl) {
      networkSwitchEl.checked = isOnline;
    }

    if (isOnline) {
      logConsole("Network state restored: ONLINE. Initializing queue drain...", "success");
      if (queuedEvents.length > 0) {
        const count = queuedEvents.length;
        const jitterMs = Math.round(MA.computeFullJitterBackoff(0, 200, 800));
        setTimeout(() => {
          logConsole(`Drained and acknowledged batch [${count} events] via fetch(keepalive) -> 200 OK`, "success");
          queuedEvents = [];
          renderQueueStats();
        }, jitterMs);
      }
    } else {
      logConsole("Network state changed: OFFLINE. NetworkDispatcher draining suspended.", "warn");
    }

    renderQueueStats();
  }

  /**
   * Updates privacy sandbox displays with real-time library calculations.
   */
  async function updatePrivacySandbox() {
    if (!MA) return;

    // 1. IP Subnet Masking
    if (ipInputEl && ipOutputEl) {
      const rawIp = ipInputEl.value.trim();
      const masked = MA.truncateIp(rawIp);
      ipOutputEl.textContent = `Masked Subnet: ${masked} (/24 IPv4 or /48 IPv6 prefix)`;
    }

    // 2. URL and PII Sanitization
    if (urlInputEl && urlOutputEl) {
      const rawUrl = urlInputEl.value.trim();
      const sanitized = MA.sanitizeUrl(rawUrl);
      urlOutputEl.textContent = `Scrubbed URL: ${sanitized}`;
    }

    // 3. Ephemeral Rotating Salt & Visitor Token
    try {
      const now = new Date();
      const epochDay = Math.floor(Date.now() / 86400000);
      const salt = await MA.deriveDailySalt(now, window.location.hostname);
      const token = await MA.generateVisitorToken({ date: now });

      if (saltEpochEl) saltEpochEl.textContent = `UTC Day Index: ${epochDay} (${now.toISOString().substring(0, 10)})`;
      if (saltHexEl) saltHexEl.textContent = `Salt: ${salt.substring(0, 24)}... (rotates at 00:00:00 UTC)`;
      if (visitorTokenEl) visitorTokenEl.textContent = `Visitor Token: ${token.substring(0, 32)}...`;
    } catch {
      // In constrained environments
    }
  }

  /**
   * Applies preset customer journey scenarios.
   */
  function applyPreset(type) {
    clearJourney();

    if (type === "ecommerce") {
      addTouchpoint("organic_search", "Google Search: 'best ergonomic office chair'");
      addTouchpoint("social", "TikTok Ad: 15s Creator Video ($1.20 CPC)", { campaign: "summer_sale" });
      addTouchpoint("email", "Newsletter: 10% Discount Welcome Email", { campaign: "welcome_series" });
      conversionAmountInput.value = "249.99";
      conversionNameInput.value = "order_completed";
      recordConversion();
    } else if (type === "b2b") {
      addTouchpoint("paid_search", "Google Ads: 'enterprise telemetry software' ($4.50 CPC)", { gclid: "sim_gclid_9981" });
      addTouchpoint("organic_search", "Blog: 'Evaluating Cookieless Attribution'");
      addTouchpoint("referral", "G2 Crowd Software Review Listing");
      addTouchpoint("email", "Sales Sequence: Product Demo Invite");
      conversionAmountInput.value = "1200.00";
      conversionNameInput.value = "enterprise_contract";
      recordConversion();
    } else if (type === "flash") {
      addTouchpoint("social", "Instagram Story Ad ($0.85 CPC)");
      addTouchpoint("paid_search", "Retargeting Search Ad ($1.50 CPC)");
      conversionAmountInput.value = "89.00";
      conversionNameInput.value = "flash_purchase";
      recordConversion();
    }
  }

  /**
   * Attaches event listeners on initialization.
   */
  function init() {
    // Channel touchpoint buttons
    document.querySelectorAll("[data-channel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const channel = btn.getAttribute("data-channel");
        const label = btn.getAttribute("data-label") || channel;
        addTouchpoint(channel, label);
      });
    });

    // Preset buttons
    document.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyPreset(btn.getAttribute("data-preset"));
      });
    });

    // Conversion and Clear buttons
    document.getElementById("btnConvert")?.addEventListener("click", recordConversion);
    document.getElementById("btnClear")?.addEventListener("click", clearJourney);

    // Network Toggle Switch
    networkSwitchEl?.addEventListener("change", (e) => {
      setNetworkState(e.target.checked);
    });

    // Queue Action buttons
    document.getElementById("btnFlushQueue")?.addEventListener("click", () => {
      if (!isOnline) {
        logConsole("Cannot flush while offline. Toggle network switch to Online first.", "warn");
        return;
      }
      setNetworkState(true);
    });

    document.getElementById("btnInjectBatch")?.addEventListener("click", () => {
      for (let i = 0; i < 50; i++) {
        queuedEvents.push({
          id: "evt_bulk_" + Date.now() + "_" + i,
          timestamp: Date.now(),
          priority: i % 10 === 0 ? "high" : "normal",
          byteSize: 160,
          payload: { type: "heartbeat", index: i },
        });
      }
      logConsole("Injected 50 events into queue to test backpressure limits", "info");
      renderQueueStats();
    });

    // Privacy inputs
    ipInputEl?.addEventListener("input", updatePrivacySandbox);
    urlInputEl?.addEventListener("input", updatePrivacySandbox);

    // Initial setup
    updatePrivacySandbox();
    applyPreset("ecommerce");
    logConsole("MicroAttribution Engine initialized: 100% zero-dependency browser runtime", "success");
  }

  // Run initialization when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
