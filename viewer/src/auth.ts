/**
 * Firebase Google 로그인. 받은 ID 토큰을 API Gateway JWT Authorizer 가 검증하고,
 * debug-fn 이 이메일을 개발자 허용 목록과 비교한다.
 *
 * Firebase 웹 설정(공개 값) 출처:
 *   로컬(npm run viewer) : viewer/.env.local 의 VITE_FIREBASE_*
 *   배포(CloudFront)     : /config.json (Terraform 이 firebase_web_api_key 로 만든다 → 다시 빌드할 필요 없음)
 */
import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

let authPromise: Promise<Auth> | undefined;

async function loadConfig(): Promise<FirebaseOptions> {
  const env = import.meta.env;
  if (env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID) {
    return {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain:
        env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
    };
  }
  const response = await fetch("/config.json", { cache: "no-cache" }).catch(() => undefined);
  const data = response?.ok
    ? ((await response.json().catch(() => undefined)) as { firebase?: FirebaseOptions } | undefined)
    : undefined;
  const firebase = data?.firebase;
  if (!firebase?.apiKey || !firebase.projectId) {
    throw new Error(
      "Firebase 웹 설정이 없어요. 로컬은 viewer/.env.local, 배포는 terraform.tfvars 의 firebase_web_api_key 를 채워 주세요.",
    );
  }
  return firebase;
}

function getFirebaseAuth(): Promise<Auth> {
  authPromise ??= loadConfig().then((config) => getAuth(initializeApp(config)));
  return authPromise;
}

export async function watchUser(callback: (user: User | null) => void): Promise<void> {
  onAuthStateChanged(await getFirebaseAuth(), callback);
}

export async function signIn(): Promise<void> {
  await signInWithPopup(await getFirebaseAuth(), new GoogleAuthProvider());
}

export async function logOut(): Promise<void> {
  await signOut(await getFirebaseAuth());
}

/** 만료가 가까우면 SDK 가 알아서 새로 받는다. */
export async function idToken(): Promise<string> {
  const user = (await getFirebaseAuth()).currentUser;
  if (!user) throw new Error("로그인이 필요합니다");
  return user.getIdToken();
}
