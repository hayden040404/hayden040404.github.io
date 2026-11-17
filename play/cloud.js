/* Back Alley Play — Firebase glue (accounts + Firestore). The ONLY file that knows about Firebase.
 * Loaded lazily: guests never download the Firebase SDK, so guest play works exactly as before
 * (and fully offline). Exposes window.BACloud.
 */
'use strict';
(function () {
  var SDK = 'https://www.gstatic.com/firebasejs/13.4.0/';
  var config = self.BA_FIREBASE_CONFIG || null;
  var fb = null;          // { app, auth, db, A: authModule, F: firestoreModule }
  var loading = null;
  var userCbs = [];

  function available() { return !!(config && config.apiKey && config.projectId); }

  function load() {
    if (!available()) return Promise.reject(new Error('Accounts aren\u2019t set up yet.'));
    if (loading) return loading;
    loading = Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js')
    ]).then(function (m) {
      var app = m[0].initializeApp(config);
      var A = m[1];
      var F = m[2];
      var auth = A.getAuth(app);
      var db = F.getFirestore(app);
      // Local test harness only (never true on the live site): talk to the Firebase emulators.
      if (config.useEmulators && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
        A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      }
      fb = { app: app, auth: auth, db: db, A: A, F: F };
      A.getRedirectResult(auth).catch(function () {});
      A.onAuthStateChanged(auth, function (u) {
        var info = u ? { uid: u.uid, email: u.email || '', name: u.displayName || '', provider: (u.providerData[0] && u.providerData[0].providerId) || 'password', photo: u.photoURL || '' } : null;
        userCbs.forEach(function (cb) { try { cb(info); } catch (e) {} });
      });
      return fb;
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  function onUser(cb) { userCbs.push(cb); }

  function friendly(err) {
    var code = (err && err.code) || '';
    var map = {
      'auth/invalid-email': 'That email address doesn\u2019t look right.',
      'auth/missing-password': 'Enter a password.',
      'auth/weak-password': 'Use a password with at least 6 characters.',
      'auth/email-already-in-use': 'There\u2019s already an account with that email. Try signing in.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/wrong-password': 'Wrong email or password.',
      'auth/user-not-found': 'No account with that email yet. Tap \u201cCreate account\u201d.',
      'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
      'auth/network-request-failed': 'You\u2019re offline. Connect to the internet to sign in.',
      'auth/popup-closed-by-user': 'Sign-in was cancelled.',
      'auth/cancelled-popup-request': 'Sign-in was cancelled.',
      'auth/unauthorized-domain': 'This site isn\u2019t allowed to sign in yet (authorized domain missing).',
      'auth/operation-not-allowed': 'That sign-in method isn\u2019t turned on yet.'
    };
    return map[code] || (err && err.message) || 'Something went wrong.';
  }

  function signInGoogle() {
    return load().then(function (f) {
      var p = new f.A.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      return f.A.signInWithPopup(f.auth, p).catch(function (err) {
        if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment')) return f.A.signInWithRedirect(f.auth, p);
        throw err;
      });
    });
  }
  function signInEmail(email, pw) { return load().then(function (f) { return f.A.signInWithEmailAndPassword(f.auth, email, pw); }); }
  function createAccount(email, pw, name) {
    return load().then(function (f) {
      return f.A.createUserWithEmailAndPassword(f.auth, email, pw).then(function (cred) {
        if (name) return f.A.updateProfile(cred.user, { displayName: name }).then(function () { return cred; });
        return cred;
      });
    });
  }
  function resetPassword(email) { return load().then(function (f) { return f.A.sendPasswordResetEmail(f.auth, email); }); }
  function signOut() { return fb ? fb.A.signOut(fb.auth) : Promise.resolve(); }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { var e = new Error('offline'); e.code = 'unavailable'; rej(e); }, ms); })]);
  }

  /** Firestore adapter for sync.js, scoped to one user's own documents. */
  function remote(uid) {
    var F = fb.F, db = fb.db;
    var userRef = F.doc(db, 'users', uid);
    var gamesCol = F.collection(db, 'users', uid, 'games');
    var histCol = F.collection(db, 'users', uid, 'history');
    var T = 20000;
    return {
      listGames: function () {
        return withTimeout(F.getDocs(gamesCol), T).then(function (qs) {
          var out = [];
          qs.forEach(function (d) { var g = self.BASync.fromGameDoc(d.id, d.data()); if (g) out.push(g); });
          return out;
        });
      },
      putGame: function (id, doc) { return withTimeout(F.setDoc(F.doc(gamesCol, id), doc), T); },
      deleteGame: function (id) { return withTimeout(F.deleteDoc(F.doc(gamesCol, id)), T); },
      listHistory: function () {
        return withTimeout(F.getDocs(histCol), T).then(function (qs) {
          var out = [];
          qs.forEach(function (d) { out.push(self.BASync.fromHistoryDoc(d.id, d.data())); });
          return out;
        });
      },
      putHistory: function (id, rec) { return withTimeout(F.setDoc(F.doc(histCol, id), rec), T); },
      putProfile: function (p) {
        var data = Object.assign({}, p, { updatedAt: F.serverTimestamp() });
        return withTimeout(F.setDoc(userRef, data, { merge: true }), T);
      }
    };
  }

  self.BACloud = {
    available: available, load: load, onUser: onUser, friendly: friendly,
    signInGoogle: signInGoogle, signInEmail: signInEmail, createAccount: createAccount,
    resetPassword: resetPassword, signOut: signOut, remote: remote
  };
})();
