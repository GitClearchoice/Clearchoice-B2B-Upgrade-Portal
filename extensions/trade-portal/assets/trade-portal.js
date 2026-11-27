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

    formEl.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy || !priced) return;
      var po = formEl.poNumber.value.trim();
      if (poRequired && !po) { showError("Please enter a PO number."); formEl.poNumber.focus(); return; }
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
              note: formEl.note.value.trim(),
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
    });

    // Themes update the cart with AJAX; re-price when the cart changes.
    document.addEventListener("cart:updated", load);
    document.addEventListener("cart:refresh", load);
    load();
  }

  function init() {
    document.querySelectorAll("[data-cc-trade-price]").forEach(initProductPrice);
    document.querySelectorAll("[data-cc-trade-order]").forEach(initTradeOrder);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
