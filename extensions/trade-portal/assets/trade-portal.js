// Clearchoice trade portal: trade prices on product and cart pages, and "Place order".
// Prices always come from the app (/apps/b2b/prices); the order is priced again on the server.
(function () {
  if (window.__ccTradePortal) return;
  window.__ccTradePortal = true;

  var GST = 0.1;
  var money = function (n) {
    return "$" + Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var newKey = function () {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  };

  // Read a JSON response; if the app or Shopify sent back a page instead (error, 404), say so plainly.
  function readJson(r) {
    return r.text().then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error("Clearchoice trade portal: expected JSON from " + r.url + " (HTTP " + r.status + "), got:", text.slice(0, 500));
        throw new Error("Prices unavailable (HTTP " + r.status + "). Please try again shortly.");
      }
    });
  }

  function fetchPrices(proxy, location, lines) {
    var q = lines.map(function (l) { return encodeURIComponent(l.sku) + ":" + l.quantity; }).join(",");
    var url = proxy + "/prices?lines=" + q + (location ? "&location=" + encodeURIComponent(location) : "");
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (r) {
      return readJson(r).then(function (body) {
        if (!r.ok) throw new Error(body.error || "Prices unavailable");
        return body;
      });
    });
  }

  // ---------- Cart change detection ----------
  // Themes update the cart with AJAX (/cart/change, /cart/update, /cart/add…) and many don't fire
  // any event. Watch those requests and tell the Trade order block to re-price.
  var CART_WRITE = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  function cartChanged() {
    document.dispatchEvent(new CustomEvent("cc:cart-changed"));
  }
  function isCartWrite(url) {
    try { return CART_WRITE.test(new URL(url, window.location.href).pathname); } catch (e) { return false; }
  }
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var p = origFetch.apply(this, arguments);
      if (isCartWrite(url)) p.then(function () { setTimeout(cartChanged, 0); }, function () {});
      return p;
    };
  }
  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isCartWrite(url)) this.addEventListener("loadend", function () { setTimeout(cartChanged, 0); });
      return origOpen.apply(this, arguments);
    };
  }

  // ---------- Product page ----------
  function initProductPrice(el) {
    var variants = [];
    try { variants = JSON.parse(el.querySelector("[data-cc-variants]").textContent); } catch (e) {}
    var out = el.querySelector("[data-cc-value]");
    var proxy = el.dataset.proxy;
    var location = el.dataset.location;
    var cache = {};
    var timer;

    function form() {
      return document.querySelector('form[action*="/cart/add"]');
    }
    function currentVariantId() {
      var f = form();
      var input = f && f.querySelector('[name="id"]');
      var fromUrl = new URLSearchParams(location_search()).get("variant");
      return String((input && input.value) || fromUrl || el.dataset.defaultVariant);
    }
    function location_search() { return window.location.search; }
    function currentQty() {
      var f = form();
      var input = (f && f.querySelector('[name="quantity"]')) || document.querySelector('input[name="quantity"]');
      var n = parseInt(input && input.value, 10);
      return n > 0 ? n : 1;
    }

    function render() {
      var id = currentVariantId();
      var v = variants.find(function (x) { return String(x.id) === id; }) || variants[0];
      if (!v || !v.sku) { out.textContent = "Contact us for pricing"; return; }
      var qty = currentQty();
      var key = v.sku + ":" + qty;
      var show = function (body) {
        var line = body.lines && body.lines[0];
        if (!line) {
          out.textContent = (body.errors && body.errors[0] && body.errors[0].error) || "Contact us for pricing";
          return;
        }
        out.innerHTML = money(line.unitExGst) + " <small>" + esc("ex GST") + " (" + money(line.unitIncGst) + " inc GST)" +
          (qty > 1 ? " each" : "") + "</small>";
      };
      if (cache[key]) return show(cache[key]);
      out.textContent = "…";
      fetchPrices(proxy, location, [{ sku: v.sku, quantity: qty }])
        .then(function (body) { cache[key] = body; if (key === v.sku + ":" + currentQty()) show(body); })
        .catch(function (e) { out.textContent = e.message; });
    }
    var schedule = function () { clearTimeout(timer); timer = setTimeout(render, 250); };
    document.addEventListener("change", schedule);
    document.addEventListener("input", function (e) { if (e.target && e.target.name === "quantity") schedule(); });
    document.addEventListener("click", function (e) { if (e.target.closest && e.target.closest(".quantity__button, [name='plus'], [name='minus']")) schedule(); });
    window.addEventListener("popstate", schedule);
    render();
  }

  // ---------- Cart page: trade order ----------
  function initTradeOrder(el) {
    var proxy = el.dataset.proxy;
    var location = el.dataset.location;
    var poRequired = el.dataset.poRequired === "true";
    var linesEl = el.querySelector("[data-cc-lines]");
    var formEl = el.querySelector("[data-cc-form]");
    var errEl = el.querySelector("[data-cc-error]");
    var submitEl = el.querySelector("[data-cc-submit]");
    var poEl = el.querySelector("[data-cc-po]");
    var noteEl = el.querySelector("[data-cc-note]");
    var doneEl = el.querySelector("[data-cc-done]");
    var requestKey = newKey();
    var cartItems = [];
    var cartSig = "";
    var sigOf = function (items) {
      return items.map(function (i) { return i.variant_id + "x" + i.quantity; }).join(",");
    };
    var priced = false;
    var busy = false;

    function showError(msg) {
      errEl.textContent = msg || "";
      errEl.hidden = !msg;
    }

    function load() {
      priced = false;
      submitEl.disabled = true;
      return fetch("/cart.js", { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (cart) {
          cartItems = cart.items || [];
          cartSig = sigOf(cartItems);
          if (!cartItems.length) {
            linesEl.innerHTML = "<p>Your cart is empty.</p>";
            return;
          }
          var noSku = cartItems.filter(function (i) { return !i.sku; });
          var bySku = {};
          cartItems.forEach(function (i) { if (i.sku) bySku[i.sku] = (bySku[i.sku] || 0) + i.quantity; });
          var req = Object.keys(bySku).map(function (s) { return { sku: s, quantity: bySku[s] }; });
          return (req.length ? fetchPrices(proxy, location, req) : Promise.resolve({ lines: [], errors: [] })).then(function (body) {
            renderLines(body, noSku);
            priced = !noSku.length && !(body.errors && body.errors.length) && body.lines.length > 0;
            submitEl.disabled = !priced;
          });
        })
        .catch(function (e) {
          linesEl.innerHTML = "<p class='cc-trade-order__line-error'>" + esc(e.message) + "</p>";
        });
    }

    function renderLines(body, noSku) {
      var price = {};
      (body.lines || []).forEach(function (l) { price[l.sku] = l; });
      var lineErr = {};
      (body.errors || []).forEach(function (e) { lineErr[e.sku] = e.error; });
      var sub = 0, gst = 0;
      var rows = cartItems.map(function (i) {
        var p = price[i.sku];
        var err = !i.sku ? "Can't be ordered online (no product code)" : lineErr[i.sku];
        var lineEx = p ? Math.round(p.unitExGst * i.quantity * 100) / 100 : 0;
        if (p) {
          sub += lineEx;
          if (p.unitIncGst > p.unitExGst) gst += Math.round(lineEx * GST * 100) / 100;
        }
        return "<tr><td>" + esc(i.product_title) + (i.variant_title ? " – " + esc(i.variant_title) : "") +
          "<br><small>" + esc(i.sku || "") + "</small>" +
          (err ? "<div class='cc-trade-order__line-error'>" + esc(err) + "</div>" : "") +
          "</td><td class='num'>" + i.quantity + "</td><td class='num'>" + (p ? money(p.unitExGst) : "–") +
          "</td><td class='num'>" + (p ? money(lineEx) : "–") + "</td></tr>";
      }).join("");
      sub = Math.round(sub * 100) / 100;
      gst = Math.round(gst * 100) / 100;
      linesEl.innerHTML =
        "<table><thead><tr><th>Product</th><th class='num'>Qty</th><th class='num'>Unit ex GST</th><th class='num'>Total ex GST</th></tr></thead>" +
        "<tbody>" + rows + "</tbody><tfoot>" +
        "<tr><td colspan='3' class='num'>Subtotal ex GST</td><td class='num'>" + money(sub) + "</td></tr>" +
        "<tr><td colspan='3' class='num'>GST</td><td class='num'>" + money(gst) + "</td></tr>" +
        "<tr><td colspan='3' class='num'>Total inc GST</td><td class='num'>" + money(sub + gst) + "</td></tr>" +
        "</tfoot></table>" +
        (noSku.length || (body.errors && body.errors.length) ? "<p class='cc-trade-order__line-error'>Remove the items marked above to place your order.</p>" : "");
    }

    // Enter in the PO field places the order (and must not submit the theme's cart form).
    poEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    submitEl.addEventListener("click", function (e) {
      e.preventDefault();
      submit();
    });

    function submit() {
      if (busy || !priced) return;
      var po = poEl.value.trim();
      if (poRequired && !po) { showError("Please enter a PO number."); poEl.focus(); return; }
      showError("");
      busy = true;
      submitEl.disabled = true;
      submitEl.textContent = "Placing order…";
      // The cart may have changed since it was priced (edited in another tab or by the theme).
      fetch("/cart.js", { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (cart) {
          if (sigOf(cart.items || []) !== cartSig) {
            var err = new Error("Your cart changed. Please check the updated prices and place your order again.");
            err.cartChanged = true;
            throw err;
          }
          return fetch(proxy + "/orders", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              requestKey: requestKey,
              location: location,
              poNumber: po || "-",
              note: noteEl.value.trim(),
              lines: cartItems.map(function (i) { return { variantId: String(i.variant_id), quantity: i.quantity }; }),
            }),
          });
        })
        .then(function (r) { return readJson(r).then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (!res.ok || !res.body.ok) throw new Error(res.body.error || "Your order couldn't be placed.");
          formEl.hidden = true;
          linesEl.hidden = true;
          doneEl.hidden = false;
          doneEl.innerHTML = "<h3>Thank you, your order has been received.</h3>" +
            "<p>Reference " + esc(res.body.reference || "") + (po ? ", PO " + esc(po) : "") +
            ", delivering to " + esc(res.body.site) + ". Goods total " + money(res.body.goodsExGst) + " ex GST.</p>";
          requestKey = newKey();
          return fetch("/cart/clear.js", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } });
        })
        .catch(function (err) {
          // Keep the same requestKey: a retry of this submission can't create a second order.
          showError(err.message);
          if (err.cartChanged) { requestKey = newKey(); load(); } else submitEl.disabled = false;
        })
        .finally(function () {
          busy = false;
          submitEl.textContent = "Place order";
        });
    }

    // Themes update the cart with AJAX; re-price when the cart changes (once the order is placed, stop).
    var reloadTimer;
    var reload = function () {
      if (!doneEl.hidden || busy) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 300);
    };
    document.addEventListener("cc:cart-changed", reload);
    document.addEventListener("cart:updated", reload);
    document.addEventListener("cart:refresh", reload);
    // Cart edited in another tab.
    document.addEventListener("visibilitychange", function () { if (!document.hidden) reload(); });
    // Safety net for themes that change the cart some other way: after any click or change on the
    // page, and every few seconds while the tab is visible, compare the cart with what was priced.
    var checking = false;
    function checkCart() {
      if (checking || busy || !doneEl.hidden || document.hidden) return;
      checking = true;
      fetch("/cart.js", { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (cart) { if (sigOf(cart.items || []) !== cartSig) reload(); })
        .catch(function () {})
        .finally(function () { checking = false; });
    }
    var nudgeTimer;
    var nudge = function () { clearTimeout(nudgeTimer); nudgeTimer = setTimeout(checkCart, 1200); };
    document.addEventListener("click", nudge, true);
    document.addEventListener("change", nudge, true);
    setInterval(checkCart, 4000);
    load();
  }

  // ---------- Product cards (recently viewed, collections, search, recommendations) ----------
  // The embed hides the theme's retail prices for trade buyers; this puts the trade price
  // (qty 1, ex GST) next to each hidden card price. Cards are found by their /products/ link.
  function initCardPrices(cfg) {
    var proxy = cfg.dataset.proxy;
    var location = cfg.dataset.location;
    var selector = cfg.dataset.selector;
    if (!selector) return;
    var root = (window.Shopify && Shopify.routes && Shopify.routes.root) || "/";
    var productCache = {}; // handle -> Promise<variants>
    var priceCache = {}; // sku -> line | null
    var timer;

    function handleOf(card) {
      var a = card.querySelector('a[href*="/products/"]');
      var m = a && a.getAttribute("href").match(/\/products\/([^/?#]+)/);
      if (!m) return null;
      var v = a.getAttribute("href").match(/[?&]variant=(\d+)/);
      return { handle: decodeURIComponent(m[1]), variant: v && v[1] };
    }
    function cardOf(el) {
      // Nearest ancestor holding a product link (a card), at most 8 levels up.
      var n = el.parentElement;
      for (var i = 0; n && i < 8; i++, n = n.parentElement) {
        if (n.querySelector('a[href*="/products/"]')) return n;
      }
      return null;
    }
    function skip(el) {
      if (el.hasAttribute("data-cc-card-done")) return true;
      if (el.parentElement && el.parentElement.closest(selector)) return true; // nested price element
      // Main product (has the Trade price block) and the cart (Trade order block prices it).
      var section = el.closest(".shopify-section");
      if (section && section.querySelector("[data-cc-trade-price]")) return true;
      if (el.closest('form[action$="/cart"], cart-drawer, cart-items, cart-drawer-items, [data-cc-trade-order]')) return true;
      return false;
    }
    function variantsOf(handle) {
      if (!productCache[handle]) {
        productCache[handle] = fetch(root + "products/" + encodeURIComponent(handle) + ".js", { headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : { variants: [] }; })
          .then(function (p) { return (p.variants || []).filter(function (v) { return v.sku; }).slice(0, 10); })
          .catch(function () { return []; });
      }
      return productCache[handle];
    }
    function priceSkus(skus) {
      var todo = skus.filter(function (k, i) { return !(k in priceCache) && skus.indexOf(k) === i; });
      var chunks = [];
      for (var i = 0; i < todo.length; i += 40) chunks.push(todo.slice(i, i + 40));
      return Promise.all(chunks.map(function (chunk) {
        return fetchPrices(proxy, location, chunk.map(function (k) { return { sku: k, quantity: 1 }; }))
          .then(function (body) {
            chunk.forEach(function (k) { priceCache[k] = null; });
            (body.lines || []).forEach(function (l) { priceCache[l.sku] = l; });
          })
          .catch(function () {});
      }));
    }
    function label(variants, preferred) {
      var chosen = preferred && variants.filter(function (v) { return String(v.id) === preferred; });
      var list = chosen && chosen.length ? chosen : variants;
      var prices = list.map(function (v) { return priceCache[v.sku]; }).filter(Boolean).map(function (l) { return l.unitExGst; });
      if (!prices.length) return null;
      var min = Math.min.apply(null, prices);
      var from = prices.some(function (p) { return p !== min; });
      return (from ? "From " : "") + money(min) + " <small>ex GST</small>";
    }

    function scan() {
      var jobs = [];
      document.querySelectorAll(selector).forEach(function (el) {
        if (skip(el)) return;
        var card = cardOf(el);
        var h = card && handleOf(card);
        el.setAttribute("data-cc-card-done", "");
        if (!h) return;
        var out = document.createElement("div");
        out.className = "cc-card-price";
        out.textContent = "…";
        el.insertAdjacentElement("afterend", out);
        jobs.push(variantsOf(h.handle).then(function (variants) { return { out: out, variants: variants, preferred: h.variant }; }));
      });
      if (!jobs.length) return;
      Promise.all(jobs).then(function (items) {
        var skus = [];
        items.forEach(function (it) { it.variants.forEach(function (v) { skus.push(v.sku); }); });
        return priceSkus(skus).then(function () {
          items.forEach(function (it) {
            var html = label(it.variants, it.preferred);
            if (html) it.out.innerHTML = html;
            else it.out.remove();
          });
        });
      });
    }

    scan();
    // Recently viewed, recommendations and infinite scroll are added after the page loads.
    new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(scan, 200); })
      .observe(document.body, { childList: true, subtree: true });
  }

  // ---------- Site picker (cart page, buyers with several sites) ----------
  function initSitePicker(el) {
    var toggle = el.querySelector("[data-cc-site-toggle]");
    var panel = el.querySelector("[data-cc-site-panel]");
    var search = el.querySelector("[data-cc-site-search]");
    var items = Array.prototype.slice.call(el.querySelectorAll("[data-cc-site-item]"));
    var empty = el.querySelector("[data-cc-site-empty]");

    function open(on) {
      panel.hidden = !on;
      toggle.setAttribute("aria-expanded", on ? "true" : "false");
      if (on && search) search.focus();
    }
    function filter() {
      var terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      items.forEach(function (li) {
        var text = li.getAttribute("data-search") || "";
        var match = terms.every(function (t) { return text.indexOf(t) !== -1; });
        li.hidden = !match;
        if (match) shown++;
      });
      empty.hidden = shown > 0;
    }

    toggle.addEventListener("click", function () { open(panel.hidden); });
    if (search) {
      search.addEventListener("input", filter);
      search.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          // Enter picks the first matching site.
          e.preventDefault();
          var first = items.filter(function (li) { return !li.hidden; })[0];
          var link = first && first.querySelector("a");
          if (link) window.location.href = link.href;
        }
      });
    }
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) { open(false); toggle.focus(); } });
    document.addEventListener("click", function (e) { if (!panel.hidden && !el.contains(e.target)) open(false); });
  }

  // One broken block (or a theme quirk) mustn't stop the others from working.
  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(function (el) {
      if (el.__ccInit) return;
      el.__ccInit = true;
      try { fn(el); } catch (e) { console.error("Clearchoice trade portal:", e); }
    });
  }
  function init() {
    each("[data-cc-site-picker]", initSitePicker);
    each("[data-cc-card-prices]", initCardPrices);
    each("[data-cc-trade-price]", initProductPrice);
    each("[data-cc-trade-order]", initTradeOrder);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
