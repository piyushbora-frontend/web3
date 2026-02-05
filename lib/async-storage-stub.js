/**
 * Web stub for @react-native-async-storage/async-storage.
 * MetaMask SDK expects this in browser; we use localStorage.
 */
const noop = () => Promise.resolve(null);
const getItem = (key) => Promise.resolve(typeof localStorage !== "undefined" ? localStorage.getItem(key) : null);
const setItem = (key, value) => {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  return Promise.resolve();
};
const removeItem = (key) => {
  if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  return Promise.resolve();
};
const clear = () => {
  if (typeof localStorage !== "undefined") localStorage.clear();
  return Promise.resolve();
};

export default {
  getItem,
  setItem,
  removeItem,
  clear,
};
