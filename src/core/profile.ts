import { requireAuth } from "../shared/auth.js";
import { ApiError } from "../shared/errors.js";
import type { HttpEvent } from "../shared/http.js";
import type { Role, UserProfile } from "./model.js";
import type { CoreStore } from "./store.js";

const CACHE_TTL_MS = 60_000;

export interface ProfileGuard {
  /** 프로필이 없으면 403 profile-required, role 이 다르면 403 permission-denied. */
  require(event: HttpEvent, role?: Role): Promise<UserProfile>;
  remember(user: UserProfile): void;
}

/**
 * 요청마다 프로필을 읽지 않도록 컨테이너 메모리에 1분간 둔다.
 * 없는 프로필은 캐시하지 않는다 (#2 직후 바로 쓸 수 있게).
 */
export function createProfileGuard(
  store: CoreStore,
  now: () => number = () => Date.now(),
): ProfileGuard {
  const cache = new Map<string, { user: UserProfile; at: number }>();

  const remember = (user: UserProfile) => {
    cache.set(user.uid, { user, at: now() });
  };

  return {
    remember,
    async require(event, role) {
      const { uid } = requireAuth(event);
      let user = cache.get(uid);
      if (user === undefined || now() - user.at > CACHE_TTL_MS) {
        const loaded = await store.getUser(uid);
        if (loaded === undefined) {
          cache.delete(uid);
          throw new ApiError("profile-required", "Register with POST /v1/users/me first");
        }
        user = { user: loaded, at: now() };
        cache.set(uid, user);
      }
      if (role !== undefined && user.user.role !== role) {
        throw new ApiError("permission-denied", `This endpoint is for role=${role}`);
      }
      return user.user;
    },
  };
}
