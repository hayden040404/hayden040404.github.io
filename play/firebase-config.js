/* Firebase web config for Back Alley accounts (project back-alley-play). These are public client
 * identifiers, safe to publish; access is enforced by Firestore security rules (each signed-in
 * player can only read/write their own users/{uid} documents). Set to null to run guest-only. */
self.BA_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDaHdWOAG3CsWAyPF8HL0AKNkYi6bv7cGg',
  authDomain: 'back-alley-play.firebaseapp.com',
  projectId: 'back-alley-play',
  storageBucket: 'back-alley-play.firebasestorage.app',
  messagingSenderId: '544263916492',
  appId: '1:544263916492:web:ab2f517623155ee5a56b69'
};
