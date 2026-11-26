/**
 * Firebase Google 로그인. 받은 ID 토큰을 API Gateway JWT Authorizer 가 검증하고,
 * debug-fn 이 이메일을 개발자 허용 목록과 비교한다.
 */
import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

let auth: Auth | undefined;

function getFirebaseAuth(): Auth {
  if (auth) return auth;
  const { VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID } = import.meta
    .env;
  if (!VITE_FIREBASE_API_KEY || !VITE_FIREBASE_PROJECT_ID) {
    throw new Error("viewer/.env.local 에 Firebase 웹 설정(VITE_FIREBASE_*)을 넣어 주세요.");
  }
  const app = initializeApp({
    apiKey: VITE_FIREBASE_API_KEY,
    authDomain: VITE_FIREBASE_AUTH_DOMAIN,
    projectId: VITE_FIREBASE_PROJECT_ID,
  });
  auth = getAuth(app);
  return auth;
}

export function watchUser(callback: (user: User | null) => void): void {
  onAuthStateChanged(getFirebaseAuth(), callback);
}

export async function signIn(): Promise<void> {
  await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
}

export async function logOut(): Promise<void> {
  await signOut(getFirebaseAuth());
}

/** 만료가 가까우면 SDK 가 알아서 새로 받는다. */
export async function idToken(): Promise<string> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("로그인이 필요합니다");
  return user.getIdToken();
}
