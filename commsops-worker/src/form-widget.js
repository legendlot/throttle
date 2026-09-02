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
  var host=document.querySelector('[data-lot-form="'+SLUG+'"]');
  if(!host) return;
  var Y='#F2CD1A';
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
  function resetChallenge(){
    token='';
    try{ if(window.turnstile && window.turnstile.reset) window.turnstile.reset(); }catch(e){}
  }
  // Turnstile renders itself; the token is the only thing the worker trusts.
  var ts=document.createElement('script');
  ts.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  ts.async=true; ts.defer=true;
  ts.onload=function(){ if(window.turnstile) window.turnstile.render(host.querySelector('.lotf-ts'),
    {sitekey:SITEKEY, callback:function(t){ token=t; }}); };
  document.head.appendChild(ts);
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
})();`;
}

module.exports = { formWidgetJs };
