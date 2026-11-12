// Public candidate page — never indexed. Sits outside (auth); the root AuthProvider only reads a session,
// it never redirects (RequireAuth, in the (auth) layout, does), so logged-out visitors stay here.
export const metadata = { title: 'Your offer · Legend of Toys', robots: { index: false, follow: false } };

export default function OfferLayout({ children }) { return children; }
