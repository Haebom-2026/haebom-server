import { defineConfig, loadEnv } from "vite";

/**
 * 로컬 실행: 브라우저는 같은 출처의 /v1/* 를 부르고, Vite 가 dev API 로 넘긴다 (CORS 설정 불필요).
 * HAEBOM_API_URL = terraform -chdir=infra/envs/dev output -raw api_endpoint
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.HAEBOM_API_URL;
  return {
    server: {
      port: 5173,
      ...(target ? { proxy: { "/v1": { target, changeOrigin: true } } } : {}),
    },
  };
});
