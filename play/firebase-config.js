/* Firebase web config for Back Alley accounts (project back-alley-play). These are public client
 * identifiers, safe to publish; access is enforced by Firestore security rules (each signed-in
 * player can only read/write their own users/{uid} documents). Set to null to run guest-only. */
self.BA_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDaHdWOAG3CsWAyPF8HL0AKNkYi6bv7cGg',
  // Sign-in helper pages are self-hosted at hayden040404.github.io/__/auth/ so Google sign-in
  // stays same-site (Safari/iOS block the cross-site firebaseapp.com storage it otherwise needs).
  authDomain: 'hayden040404.github.io',
  projectId: 'back-alley-play',
  storageBucket: 'back-alley-play.firebasestorage.app',
  messagingSenderId: '544263916492',
  appId: '1:544263916492:web:ab2f517623155ee5a56b69'
};
