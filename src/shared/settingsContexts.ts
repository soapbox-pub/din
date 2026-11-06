import { createContext } from 'react';

/** Whether Settings is showing search results, several sections one after another. */
export const SettingsSearchingContext = createContext(false);

/** Whether a setting is a row of a SettingsGroup, so not a card of its own. */
export const SettingsGroupContext = createContext(false);
