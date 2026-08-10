// LOT launch-email STARTER — MJML, canvas-native.
//
// WHY THIS EXISTS. The ad-engine pipeline (~/Documents/Brand/ad-engine/creatives/) emits
// hand-authored table HTML that is byte-exact by construction. That is the right format to SEND,
// but it is a dead end inside Relay: grapesjs-mjml renders MJML, so an imported HTML template
// opens on a blank canvas and cannot be cloned or edited. Building the next launch email from
// the blank scaffold is hours of work.
//
// So this is the same design expressed as MJML: close enough to eyeball against the shipped
// Roxie email, and fully editable in the canvas. Duplicate it, swap the copy and images, send.
//
// ⚠️ It is NOT byte-identical to the ad-engine HTML and is not trying to be — MJML emits its own
// table scaffolding. Where the two disagree, the ad-engine build is the reference for a send and
// this is the reference for AUTHORING.
//
// Design system (HANDOFF §6): 600px canvas · bg #080808 · panel #0E0E0E · card #111111 ·
// accent #FFC72C (action/emphasis only, never decoration) · heading #FFFFFF · body #A8A8A8 ·
// muted #6A6A6A · hairline #232323 · text-on-accent #080808. Helvetica stack, no webfonts —
// Outlook and Gmail drop them and the fallback reflows. Hierarchy comes from weight and
// tracking, not colour.
//
// ⚠️ KEEP {unsubscribe_url} IN THE FOOTER. save() hard-blocks a marketing template whose exported
// HTML lacks it, and it is legally required on a commercial send.

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export const LOT_LAUNCH_MJML = `<mjml>
  <mj-head>
    <mj-title>Roxie — roads are optional</mj-title>
    <mj-preview>1:20 scale. 4WD. Two bodies, four colourways — and this drop is a one-time run.</mj-preview>
    <mj-attributes>
      <mj-all font-family="${FONT}" />
      <mj-text color="#A8A8A8" font-size="15px" line-height="25px" />
      <mj-section background-color="#080808" padding="0px" />
    </mj-attributes>
    <mj-style>
      .eyebrow div { letter-spacing: 2.2px !important; text-transform: uppercase; }
      .speclabel div { letter-spacing: 1.6px !important; text-transform: uppercase; }
      .rule td { font-size: 0 !important; line-height: 0 !important; }
    </mj-style>
  </mj-head>

  <mj-body background-color="#080808" width="600px">

    <!-- Logo -->
    <mj-section background-color="#080808" padding="28px 44px 18px">
      <mj-column>
        <mj-image align="center" width="112px" padding="0"
          src="https://www.legendoftoys.com/cdn/shop/files/Legend_of_Toys_White_Transparent_logo.webp?v=1761501274&width=240&format=png"
          alt="Legend of Toys" />
      </mj-column>
    </mj-section>

    <!-- Hero -->
    <mj-section background-color="#0E0E0E" padding="0">
      <mj-column>
        <mj-image padding="0" width="600px"
          src="https://cdn.shopify.com/s/files/1/0669/4721/9508/files/Asset_27_1a5962cc-2428-4af4-b15b-7c89a967e338.webp?width=900"
          alt="Roxie RC crawler in Navigate Blue, climbing wet rock in a forest, with its 2.4GHz controller alongside"
          href="https://lottoys.in/r/roxie-launch-emailer" />
      </mj-column>
    </mj-section>

    <!-- Headline block -->
    <mj-section background-color="#0E0E0E" padding="34px 44px 38px">
      <mj-column>
        <mj-text css-class="eyebrow" color="#FFC72C" font-size="11px" line-height="14px" font-weight="800" padding="0 0 14px">
          New arrival &nbsp;&middot;&nbsp; L.O.T Cars
        </mj-text>
        <mj-text color="#FFFFFF" font-size="46px" line-height="46px" font-weight="800" letter-spacing="-1.4px" padding="0 0 16px">
          Roads are optional.
        </mj-text>
        <mj-text font-size="16px" line-height="26px" padding="0 0 24px">
          Meet <span style="color:#FFFFFF;font-weight:600;">Roxie</span> — a 1:20 scale, 4WD
          hobby-grade crawler built for the places a road never reached.
        </mj-text>

        <mj-text padding="0 0 22px">
          <span style="color:#FFFFFF;font-size:38px;line-height:38px;font-weight:800;letter-spacing:-1px;">&#8377;4,599</span>
          <span style="color:#6E6E6E;font-size:16px;text-decoration:line-through;padding-left:10px;">&#8377;5,999</span>
          <span style="background:#FFC72C;color:#080808;font-size:11px;font-weight:800;letter-spacing:1px;padding:4px 8px;border-radius:3px;margin-left:10px;">SAVE 23%</span>
        </mj-text>

        <mj-button background-color="#FFC72C" color="#080808" font-size="14px" font-weight="800"
          letter-spacing="1.4px" inner-padding="16px 34px" border-radius="4px" align="left" padding="0 0 16px"
          href="https://lottoys.in/r/roxie-launch-emailer">SHOP ROXIE</mj-button>

        <mj-text color="#6A6A6A" font-size="12px" line-height="18px" padding="0">
          Free delivery &nbsp;&middot;&nbsp; COD available &nbsp;&middot;&nbsp; Ships pre-charged
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Story -->
    <mj-section background-color="#080808" padding="40px 44px 8px">
      <mj-column>
        <mj-table css-class="rule" padding="0 0 18px" width="44px">
          <tr><td style="height:3px;background:#FFC72C;font-size:0;line-height:0;">&nbsp;</td></tr>
        </mj-table>
        <mj-text color="#FFFFFF" font-size="27px" line-height="32px" font-weight="800" letter-spacing="-0.5px" padding="0 0 14px">
          Built for the places roads forgot.
        </mj-text>
        <mj-text padding="0">
          Roxie's story starts where the tarmac stops — village to village, supplies on the back,
          over whatever's in the way. The story is ours. The hardware underneath it is very real.
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Specs -->
    <mj-section background-color="#080808" padding="34px 44px 10px">
      <mj-column background-color="#111111" padding="30px 28px" border-radius="6px">
        <mj-text color="#FFFFFF" font-size="19px" line-height="26px" font-weight="800" letter-spacing="-0.2px" padding="0 0 20px">
          Speed doesn't work off-road.<br />Power does.
        </mj-text>

        <mj-text css-class="speclabel" color="#FFC72C" font-size="11px" line-height="14px" font-weight="800" padding="0 0 6px">
          4WD &nbsp;&middot;&nbsp; 1:20 scale
        </mj-text>
        <mj-text font-size="14px" line-height="23px" padding="0 0 18px">
          High torque where it counts, on a flexible suspension that's fine-tuned to soak up rock,
          rut and root instead of bouncing off them.
        </mj-text>

        <mj-divider border-width="1px" border-color="#232323" padding="0 0 18px" />

        <mj-text css-class="speclabel" color="#FFC72C" font-size="11px" line-height="14px" font-weight="800" padding="0 0 6px">
          Dual-dial 2.4GHz control
        </mj-text>
        <mj-text font-size="14px" line-height="23px" padding="0 0 18px">
          Steering trim on one dial, stepless speed on the other. Crawling punishes guesswork — so
          you tune the car to the trail, not the other way round.
        </mj-text>

        <mj-divider border-width="1px" border-color="#232323" padding="0 0 18px" />

        <mj-text css-class="speclabel" color="#FFC72C" font-size="11px" line-height="14px" font-weight="800" padding="0 0 6px">
          LED lights — with working indicators
        </mj-text>
        <mj-text font-size="14px" line-height="23px" padding="0 0 18px">
          Headlights, tails and indicators that actually signal. Night runs look the part, and so
          do the photos.
        </mj-text>

        <mj-divider border-width="1px" border-color="#232323" padding="0 0 18px" />

        <mj-text css-class="speclabel" color="#FFC72C" font-size="11px" line-height="14px" font-weight="800" padding="0 0 6px">
          Durable ABS body
        </mj-text>
        <mj-text font-size="14px" line-height="23px" padding="0">
          Hobby grade means it's meant to be driven, dropped and driven again. BIS compliant, and
          made in India.
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Colourway grid -->
    <mj-section background-color="#080808" padding="38px 44px 6px">
      <mj-column>
        <mj-table css-class="rule" padding="0 0 18px" width="44px">
          <tr><td style="height:3px;background:#FFC72C;font-size:0;line-height:0;">&nbsp;</td></tr>
        </mj-table>
        <mj-text color="#FFFFFF" font-size="27px" line-height="32px" font-weight="800" letter-spacing="-0.5px" padding="0 0 14px">
          Two bodies. Four colourways.
        </mj-text>
        <mj-text padding="0 0 8px">
          <span style="color:#FFFFFF;font-weight:600;">Navigate</span> is the hardtop wagon.
          <span style="color:#FFFFFF;font-weight:600;">Explorer</span> is the pickup, spare wheel on
          the bed. Same running gear underneath — pick the one you'd rather be seen driving.
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="#080808" padding="8px 34px 0">
      <mj-column width="50%">
        <mj-image padding="10px" border-radius="6px" href="https://lottoys.in/r/roxie-launch-emailer"
          src="https://cdn.shopify.com/s/files/1/0669/4721/9508/files/Asset_27_1a5962cc-2428-4af4-b15b-7c89a967e338.webp?width=400" alt="Roxie Navigate Blue" />
        <mj-text color="#FFFFFF" font-size="13px" line-height="17px" font-weight="700" align="center" padding="0 0 2px">Navigate Blue</mj-text>
        <mj-text color="#6A6A6A" font-size="11px" line-height="15px" align="center" padding="0 0 14px">Hardtop wagon</mj-text>
      </mj-column>
      <mj-column width="50%">
        <mj-image padding="10px" border-radius="6px" href="https://lottoys.in/r/roxie-launch-emailer"
          src="https://cdn.shopify.com/s/files/1/0669/4721/9508/files/Asset_26_25d9e8da-aa68-4ec9-8af4-ba8dfb6c9f9f.webp?width=400" alt="Roxie Navigate Red" />
        <mj-text color="#FFFFFF" font-size="13px" line-height="17px" font-weight="700" align="center" padding="0 0 2px">Navigate Red</mj-text>
        <mj-text color="#6A6A6A" font-size="11px" line-height="15px" align="center" padding="0 0 14px">Hardtop wagon</mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="#080808" padding="0 34px 10px">
      <mj-column width="50%">
        <mj-image padding="10px" border-radius="6px" href="https://lottoys.in/r/roxie-launch-emailer"
          src="https://cdn.shopify.com/s/files/1/0669/4721/9508/files/Asset_25_6d48c4ee-1fdc-4ed1-b92d-daa2572ad30a.webp?width=400" alt="Roxie Explorer Yellow" />
        <mj-text color="#FFFFFF" font-size="13px" line-height="17px" font-weight="700" align="center" padding="0 0 2px">Explorer Yellow</mj-text>
        <mj-text color="#6A6A6A" font-size="11px" line-height="15px" align="center" padding="0 0 14px">Pickup</mj-text>
      </mj-column>
      <mj-column width="50%">
        <mj-image padding="10px" border-radius="6px" href="https://lottoys.in/r/roxie-launch-emailer"
          src="https://cdn.shopify.com/s/files/1/0669/4721/9508/files/Asset_24_b3504a1f-8b79-461a-91c0-f9879acef208.webp?width=400" alt="Roxie Explorer Aqua" />
        <mj-text color="#FFFFFF" font-size="13px" line-height="17px" font-weight="700" align="center" padding="0 0 2px">Explorer Aqua</mj-text>
        <mj-text color="#6A6A6A" font-size="11px" line-height="15px" align="center" padding="0 0 14px">Pickup</mj-text>
      </mj-column>
    </mj-section>

    <!-- Closing CTA -->
    <mj-section background-color="#080808" padding="26px 44px 40px">
      <mj-column background-color="#111111" padding="30px 28px" border-radius="6px">
        <mj-text css-class="eyebrow" color="#FFC72C" font-size="11px" line-height="14px" font-weight="800" padding="0 0 12px">
          Limited drop
        </mj-text>
        <mj-text color="#FFFFFF" font-size="22px" line-height="30px" font-weight="800" letter-spacing="-0.3px" padding="0 0 12px">
          This is a one-time run.
        </mj-text>
        <mj-text padding="0 0 22px">
          Roxie isn't a permanent addition to the garage. When the four colourways sell through,
          that's the run.
        </mj-text>
        <mj-button background-color="#FFC72C" color="#080808" font-size="14px" font-weight="800"
          letter-spacing="1.4px" inner-padding="16px 34px" border-radius="4px" align="left" padding="0"
          href="https://lottoys.in/r/roxie-launch-emailer">CLAIM YOURS — &#8377;4,599</mj-button>
      </mj-column>
    </mj-section>

    <!-- Trust strip -->
    <mj-section background-color="#0E0E0E" padding="18px 44px">
      <mj-column>
        <mj-text color="#7A7A7A" font-size="11px" line-height="18px" align="center" padding="0">
          BIS compliant &nbsp;&middot;&nbsp; Made in India &nbsp;&nbsp;&middot;&nbsp; Free delivery
          &nbsp;&middot;&nbsp; COD available
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section background-color="#080808" padding="26px 44px 40px">
      <mj-column>
        <mj-text color="#6A6A6A" font-size="12px" line-height="18px" align="center" padding="0 0 10px">
          Fuel the Fun. Live the Legend.
        </mj-text>
        <mj-text color="#6A6A6A" font-size="11px" line-height="18px" align="center" padding="0 0 8px">
          You're getting this because you signed up at legendoftoys.com.
        </mj-text>
        <mj-text color="#8A8A8A" font-size="11px" line-height="18px" align="center" padding="0 0 8px">
          <a href="{unsubscribe_url}" style="color:#8A8A8A;text-decoration:underline;">Unsubscribe</a>
          &nbsp;&middot;&nbsp;
          <a href="https://legendoftoys.com" style="color:#8A8A8A;text-decoration:underline;">Visit the store</a>
        </mj-text>
        <mj-text color="#3E3E3E" font-size="11px" line-height="18px" align="center" padding="0">
          Fraternitas Ventures Private Limited &middot; No 938, 3rd Cross, 1st Block, HRBR Layout,
          Kalyanagar, Bangalore, Karnataka 560043, India
        </mj-text>
      </mj-column>
    </mj-section>

  </mj-body>
</mjml>`;

export default LOT_LAUNCH_MJML;
