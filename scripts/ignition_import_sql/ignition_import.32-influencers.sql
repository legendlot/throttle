-- 10 influencer rows
INSERT INTO ignition._stage_influencers (
  influencer_code,
  channel_name,
  person_name,
  channel_link,
  channel_platform,
  influencer_type,
  categories,
  reach,
  audience,
  location,
  contact_number,
  address,
  email,
  contact_poc_type,
  contact_poc_name,
  first_invite_sent_at,
  list_status,
  legacy_sheet_ref
) VALUES
('IBL0016', 'BigBuddyToys', NULL, 'https://www.youtube.com/@BigBuddyToys/shorts', 'youtube', 'nano', ARRAY['rc', 'unboxing', 'review', 'vlogs']::text[], 20000, 'Enthusiasts', NULL, NULL, NULL, 'bigbuddytoys@gmail.com', NULL, NULL, '2026-05-28T00:00:00Z', 'b_list', 'omnipres-blist-3eb817e180051e2d'),
('IBL0017', 'jaimantoys', NULL, 'https://www.instagram.com/jaimantoys/', 'instagram', 'store', ARRAY['toys', 'diecast', 'rc']::text[], 1500, 'kids/enthusiasts', 'New Delhi', '+919899747688', NULL, NULL, NULL, NULL, '2026-05-28T00:00:00Z', 'b_list', 'omnipres-blist-7b985a81bfd2621d'),
('IBL0018', 'natkhatBoy001', NULL, 'https://www.youtube.com/@natkhatBoy001', 'youtube', 'macro', ARRAY['review', 'rc', 'cinematic']::text[], 15000, 'enthusiasts', NULL, NULL, NULL, 'riteshgg9219@gmail.com', NULL, NULL, '2026-05-28T00:00:00Z', 'b_list', 'omnipres-blist-1e121b5410c21e4d'),
('IBL0019', 'rahulkollamvlog', 'Rahul', 'https://www.instagram.com/rahulkollamvlog/', 'instagram', 'nano', ARRAY['vlogs', 'review', 'finds', 'tech']::text[], 30000, 'general', NULL, '+919536958422', NULL, NULL, NULL, NULL, '2026-05-28T00:00:00Z', 'b_list', 'omnipres-blist-13e264a660da5dda'),
('IBL0020', 'ARUV_ARMY', NULL, 'https://www.youtube.com/@ARUV_ARMY/shorts', 'youtube', 'macro', ARRAY['rc', 'tech', 'toys', 'review']::text[], 50000, 'Enthusiasts', NULL, NULL, NULL, 'rahul13apna@gmail.com', NULL, NULL, '2026-05-28T00:00:00Z', 'b_list', 'omnipres-blist-9f03ef95fa06c57b'),
('IBL0021', 'Afuniquetoyz12', NULL, 'https://www.youtube.com/@Afuniquetoyz12/shorts', 'youtube', 'store', ARRAY['rc', 'toys']::text[], 80000, 'kids', NULL, NULL, NULL, 'abjalhussain9986@gmail.com', NULL, NULL, '2026-05-28T00:00:00Z', 'b_list', 'omnipres-blist-d8e66bd49a59a682'),
('IBL0022', 'sharmajitechnical', 'Praval Sharma', 'https://www.instagram.com/sharmajitechnical/reels/', 'instagram', 'micro', ARRAY['review', 'tech']::text[], 10000, 'enthusiasts', 'Rajasthan', NULL, NULL, NULL, NULL, NULL, NULL, 'b_list', 'omnipres-blist-181bc6301a8d98d4'),
('IBL0023', 'akhilhemadri', 'Akhil Yadav', 'https://www.instagram.com/akhilhemadri/reels/', 'instagram', 'nano', ARRAY['auto', 'vlogs']::text[], 100000, 'enthusiasts', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'b_list', 'omnipres-blist-4e1ee269bd48394d'),
('IBL0024', 'tronplayworld', NULL, 'https://www.instagram.com/tronplayworld/reels/', 'instagram', 'nano', ARRAY['diecast', 'rc', 'toys']::text[], 2000, 'enthusiasts', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'b_list', 'omnipres-blist-eab6ecc309590fc4'),
('IBL0025', 'keraladiecastcrew', 'Sankar Shaji', 'https://www.instagram.com/keraladiecastcrew/', 'instagram', 'nano', ARRAY['unboxing', 'review', 'diecast']::text[], 5000, 'Kerala', 'DM/9847322279', '+11992695011', 'Influencer', 'True', NULL, NULL, NULL, 'b_list', 'omnipres-blist-460e42824baabd67')
ON CONFLICT (influencer_code) DO NOTHING;
