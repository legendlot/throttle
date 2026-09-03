// The embeddable form widget (S331, SP1) — one <script> tag on a PDP.
// Mirrors src/bot-widget.js exactly: a string-templated, self-contained IIFE with inline
// styles, no framework and no external assets beyond Cloudflare's own Turnstile script.
//
// Usage on the storefront:
//   <div data-lot-form="back-in-stock" data-product="GH-PB-49"></div>
//   <script src="https://commsops.<...>.workers.dev/f/widget.js?form=back-in-stock" defer></script>
function formWidgetJs(slug, workerBase, siteKey) {
  const s = JSON.stringify(String(slug || ''));
  const base = JSON.stringify(String(workerBase || ''));
  const key = JSON.stringify(String(siteKey || ''));
  return `(function(){
  var SLUG=${s}, BASE=${base}, SITEKEY=${key};
  // ⚠️ querySelectorALL, and an idempotence guard, both load-bearing (S342). Found by the
  // storefront lane on the real theme: Focal renders the product form THREE times in the raw
  // HTML (main + quick-buy drawer + quick-buy popover templates). Only one host is in the live
  // DOM on a sold-out PDP today, but if a quick-buy surface is ever instantiated a second host
  // AND a second copy of this script appear — and the old querySelector-singular meant the
  // second copy re-initialised the FIRST host, wiping a customer's half-typed email and
  // orphaning its Turnstile widget. Init every host, exactly once each.
  var hosts=document.querySelectorAll('[data-lot-form="'+SLUG+'"]');
  if(!hosts.length) return;
  var Y='#F2CD1A';
  for(var hi=0;hi<hosts.length;hi++) initHost(hosts[hi]);
  function initHost(host){
  if(host.getAttribute('data-lotf-init')==='1') return;   // already wired by an earlier copy
  host.setAttribute('data-lotf-init','1');
  host.innerHTML='<form style="display:flex;flex-direction:column;gap:8px;max-width:340px;font:14px system-ui">'
    +'<input name="email" type="email" required placeholder="Email address" style="padding:10px;border:1px solid #ccc;border-radius:6px">'
    +'<label style="display:flex;gap:6px;align-items:center"><input name="wa" type="checkbox"><span>Also tell me on WhatsApp</span></label>'
    +'<input name="phone" type="tel" placeholder="WhatsApp number" style="padding:10px;border:1px solid #ccc;border-radius:6px;display:none">'
    +'<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">'
    +'<div class="lotf-ts"></div>'
    +'<button type="submit" style="padding:10px;border:0;border-radius:6px;background:'+Y+';font-weight:600;cursor:pointer">Notify me</button>'
    +'<p class="lotf-msg" style="margin:0;color:#555" aria-live="polite"></p></form>';
  var f=host.querySelector('form'), msg=host.querySelector('.lotf-msg');
  var wa=f.wa, phone=f.phone;
  wa.addEventListener('change',function(){ phone.style.display=wa.checked?'block':'none'; });
  var token='';
  // ⚠️ A TURNSTILE TOKEN IS SINGLE-USE. Spend it, and the next submit sends a spent token and
  // gets challenge_failed forever until a full page reload — so a customer who mistypes their
  // email, reads 'bad_email', fixes it and resubmits was permanently bricked by their own typo.
  // Reset after EVERY response, success or failure: the widget must always hold a fresh token.
  // ⚠️ RESET BY WIDGET ID, NOT BARE (S342 hostile review, finding 7). \`turnstile.reset()\` with no
  // argument resets the FIRST widget on the page. With multi-host init there can be N, so a bare
  // reset in the quick-buy drawer would reset the MAIN PDP widget and leave the drawer's own token
  // spent — which is verbatim the brick the note above says this function prevents. Capture the id
  // \`render()\` returns and reset exactly ours.
  var wid=null;
  function resetChallenge(){
    token='';
    try{ if(window.turnstile && window.turnstile.reset) window.turnstile.reset(wid||undefined); }catch(e){}
  }
  // Turnstile renders itself; the token is the only thing the worker trusts.
  // ⚠️ ONE api.js for the page, not one per host — N copies is N script tags and N loads.
  function withTurnstile(cb){
    if(window.turnstile) return cb();
    var prior=document.querySelector('script[data-lotf-ts]');
    if(prior){ prior.addEventListener('load',cb); return; }
    var ts=document.createElement('script');
    ts.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    ts.async=true; ts.defer=true; ts.setAttribute('data-lotf-ts','1');
    ts.addEventListener('load',cb);
    document.head.appendChild(ts);
  }
  withTurnstile(function(){ if(window.turnstile) wid=window.turnstile.render(host.querySelector('.lotf-ts'),
    {sitekey:SITEKEY, callback:function(t){ token=t; }}); });
  f.addEventListener('submit',function(e){
    e.preventDefault();
    msg.textContent='Sending...';
    var payload={form:SLUG, turnstile_token:token, source_url:location.href,
      email:f.email.value, website:f.website.value,
      product_code:(host.getAttribute('data-product')||''),
      channels: wa.checked?['email','whatsapp']:['email']};
    if(wa.checked) payload.phone=phone.value;
    fetch(BASE+'/f/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json();})
      .then(function(j){
        resetChallenge();
        msg.textContent = j && j.ok ? "You're on the list. We'll let you know." : 'Sorry, that did not go through.';
        // Disabled ONLY on genuine success. A failed submit must stay retryable.
        if(j && j.ok) f.querySelector('button').disabled=true;
      })
      .catch(function(){ resetChallenge(); msg.textContent='Sorry, that did not go through.'; });
  });
  }
})();`;
}

module.exports = { formWidgetJs };
