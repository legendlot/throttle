'use client';
import { createContext, useContext } from 'react';

// Bridges the (auth) layout chrome (DocketTopbar) with the active page.
// A board page publishes its visible task count via `setCount`; the topbar
// renders it as a pill. The sidebar collapse + the keyboard-shortcuts sheet
// are owned by the layout and exposed here so any surface can drive them.
export const ChromeContext = createContext(null);
export function useChrome() { return useContext(ChromeContext) || {}; }
