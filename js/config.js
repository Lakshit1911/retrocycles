// Firebase web app config. These values identify the project and are meant to
// ship to the browser; access is controlled by database.rules.json and the
// sign-in providers enabled in the Firebase console.
//
// authDomain: on the deployed site, Firebase's sign-in pages are served from our own
// domain through the rewrite in vercel.json. That keeps Google sign-in first-party;
// browsers that partition third-party storage otherwise lose the sign-in result.
// Local development keeps the project's default firebaseapp.com domain.
const FIREBASE_AUTH_HOST = "retrocycles-e9965.firebaseapp.com";
const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname);

export const firebaseConfig = {
  apiKey: "AIzaSyAwI7mYUbIeV1TLohXBTHlUMxX6WwjgJi8",
  authDomain: local ? FIREBASE_AUTH_HOST : location.host,
  databaseURL: "https://retrocycles-e9965-default-rtdb.firebaseio.com",
  projectId: "retrocycles-e9965",
  storageBucket: "retrocycles-e9965.firebasestorage.app",
  messagingSenderId: "211015905480",
  appId: "1:211015905480:web:8ac9a0a16aa7d74b17f5fd"
};
