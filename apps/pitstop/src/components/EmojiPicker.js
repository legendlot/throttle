'use client';
/* Full emoji picker (emoji-mart) — isolated in its own module so the ~bundled
   emoji dataset only loads in this lazy chunk, never on the main inbox bundle.
   Imported via next/dynamic({ ssr:false }) from the inbox composer. */
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

export default function EmojiPicker({ onSelect }) {
  return (
    <Picker
      data={data}
      theme="dark"
      navPosition="top"
      previewPosition="none"
      skinTonePosition="search"
      perLine={8}
      maxFrequentRows={2}
      onEmojiSelect={(e) => onSelect?.(e.native)}
    />
  );
}
