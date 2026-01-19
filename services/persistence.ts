
/**
 * Persistence service for UU EEE Assistant
 * Supports JSONBin.io as a remote server and localStorage as a local cache.
 */

// Placeholder credentials - Users should replace these with their own from jsonbin.io
const JSONBIN_API_KEY = "$2b$10$EXAMPLE_KEY_REPLACE_ME"; // X-Master-Key
const JSONBIN_BIN_ID = "64fEXAMPLE_BIN_ID"; // Bin ID

export interface AppData {
  routine: any[];
  students: any[];
  faculty: any[];
  notices: any[];
  attendance: any[];
  polls: any[];
  courses: any[];
}

const LOCAL_STORAGE_KEY = "uu_eee_master_state";

export const persistence = {
  /**
   * Loads data from JSONBin or falls back to localStorage
   */
  async load(): Promise<AppData | null> {
    try {
      // Try fetching from JSONBin
      const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: {
          "X-Master-Key": JSONBIN_API_KEY,
        },
      });

      if (response.ok) {
        const result = await response.json();
        const data = result.record as AppData;
        // Update local cache
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
        return data;
      }
    } catch (error) {
      console.error("JSONBin load error (falling back to local):", error);
    }

    // Fallback to local storage
    const localData = localStorage.getItem(LOCAL_STORAGE_KEY);
    return localData ? JSON.parse(localData) : null;
  },

  /**
   * Saves data to JSONBin and localStorage
   */
  async save(data: AppData): Promise<boolean> {
    // Save to local storage immediately
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));

    try {
      const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Master-Key": JSONBIN_API_KEY,
        },
        body: JSON.stringify(data),
      });

      return response.ok;
    } catch (error) {
      console.error("JSONBin save error:", error);
      return false;
    }
  }
};
