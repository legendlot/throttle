// ⚠️ The starter button's href was the BARE HOMEPAGE until 2026-08-16, so every email began life
// with a "Shop now" CTA pointing at legendoftoys.com — and an author who never touched it shipped
// that (Mishica, #bugs 1786189428.760609). A shop-all collection is the honest default for a
// button labelled "Shop now"; the homepage is where a reader who wanted to browse would already
// have gone. The templates page separately asks for confirmation before saving an email whose CTA
// is still the bare homepage, so neither the old default nor a hand-typed one ships silently.
//
// NB this scaffold seeds NEW emails only — changing it never touches a saved template.
export const BLANK_MJML = `<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="700" color="#282828">Heading</mj-text>
        <mj-text font-size="14px" line-height="1.6" color="#282828">Write your email here. Insert merge tags from the toolbar above.</mj-text>
        <mj-button background-color="#F2CD1A" color="#282828" href="https://www.legendoftoys.com/collections/all">Shop now</mj-button>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="0 24px 24px">
      <mj-column>
        <mj-text font-size="11px" color="#888888" align="center">
          Legend of Toys · <a href="{unsubscribe_url}" style="color:#888888">Unsubscribe</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
