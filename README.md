# flow-control-practice

TypeScript + Node.js로 구현한 **API rate limiting & concurrency control** 학습용 데모. 브라우저 대시보드에서 토큰 버킷·큐·슬롯 동작을 실시간으로 관찰할 수 있다.

외부 런타임 의존성 0. Node 내장 `http`/`crypto`/`fs`/`path`만 사용.

## Features

- **TokenBucket** — 초당 N개 리필하는 입장권 시스템 (rate limiting)
- **ConcurrencyLimiter** — 동시 처리 슬롯 제한 + FIFO 큐 (concurrency control)
- **Shaping** (v2) — 토큰 초과 요청을 즉시 거절하지 않고 대기 큐에서 기다림
- **대시보드** — SSE 실시간 스트리밍. 6개 카드 + 파이프라인 시각화 + 요청 로그
- **Burst 시연** — 1건 단위 `send`, N건 동시 발사 `burst`, 카운터 `reset`
- **보안** — CSP, timing-safe token 비교, optional Bearer/query auth

## Quick start

### 요구사항
- Node.js 18+
- npm

### 설치 & 실행
```bash
git clone <repo-url>
cd flow-control-practice
npm install
npm run build
npm start
```

브라우저에서 `http://localhost:3000/` 접속.

### 개발 모드
```bash
npm run dev   # build + start 한 번에
```

### 테스트
```bash
npm test      # Jest, 134개 케이스
```

## 사용법

대시보드 상단 `Help` 버튼 클릭하면 6개 섹션으로 전체 가이드가 펼쳐진다:
1. 이게 뭐예요?
2. 요청이 거치는 5단계
3. 카드 의미 한 줄씩
4. 로그 읽는 법
5. 이렇게 해보세요 (시나리오 5가지)
6. 어느 카드가 빨개지나로 원인 파악

간단 요약:

| 버튼 | 동작 |
|------|------|
| **send** | POST /api/work 1건 발사 |
| **fire** (burst 옆) | N건을 서버 내부에서 동시 발사 (브라우저 연결 제한 우회) |
| **reset** | 카운터·로그 초기화 (활성 요청은 유지) |

**추천 시나리오 순서**
1. `send` 몇 번 → 여유 상태 관찰
2. `burst 10` → 큐 쌓이는 모습
3. `burst 30` → 토큰 대기(shaping) 관찰
4. `burst 100` → 429 거절 발생
5. `burst 500` → 503 Rate Queue Full 극한 테스트

## 설정

`src/index.ts` 상단에서 조정:
```ts
const flowControl = createFlowControl({
  concurrency: { max: 3 },
  tokenBucket: { capacity: 10, refillRate: 5 },
  queue: { maxSize: 100 },
  rateQueueMaxSize: 100,
  rateWaitTimeout: 5_000,
  queueTimeout: 30_000,
});
```

환경변수:
- `PORT` — 서버 포트 (기본 3000)
- `FLOW_CONTROL_AUTH_TOKEN` — 설정 시 `/api/*`에 Bearer 또는 `?token=xxx` 인증 필수

## 엔드포인트

| method | path | 설명 |
|--------|------|------|
| GET | `/` | 대시보드 HTML |
| GET | `/dashboard.{css,js}` | 정적 자산 |
| GET | `/api/metrics` | 현재 상태 JSON 스냅샷 |
| GET | `/api/events` | SSE — 1초 간격으로 metrics push |
| POST | `/api/work` | 실제 처리 시뮬레이션 (500~2000ms 랜덤 지연) |
| POST | `/api/burst?n=N` | 서버 내부에서 N개 동시 발사, NDJSON 스트리밍 응답 |
| POST | `/api/reset` | 카운터·샘플 초기화 (활성 슬롯은 유지) |

## 아키텍처

```
src/
├── core/
│   ├── TokenBucket.ts      토큰 버킷 + pending FIFO 큐 (shaping)
│   ├── ConcurrencyLimiter.ts  슬롯 카운터 + 큐
│   ├── Queue.ts            FIFO + maxSize 상한
│   ├── WaitingInfo.ts      대기 순번·예상 대기시간 value object
│   └── errors.ts           RateTimeoutError, RateQueueFullError
├── middleware/
│   └── flowControl.ts      조합 미들웨어 (TokenBucket → Limiter → next → release)
├── server/
│   ├── router.ts           switch 기반 라우팅
│   ├── auth.ts             optional Bearer/query token
│   ├── responseHelpers.ts  보안 헤더 + writeSecureHead
│   ├── static.ts           public 서빙 + path traversal 방어
│   └── handlers/           sse, metrics, demo, burst, reset
├── public/                 대시보드 HTML/CSS/JS (빌드 시 dist/public으로 복사)
└── utils/logger.ts         구조화 로거 (console.log 금지)
```

## 알려진 제약

- **브라우저에서 burst**: HTTP/1.1 same-origin 동시 연결 제한(6) 때문에 클라이언트가 직접 N개 fetch를 동시에 보내도 서버에 serialize되어 도착한다. 이를 우회하기 위해 `/api/burst` 엔드포인트가 서버 내부에서 N개를 동시 투입한다.
- **단일 인스턴스**: 상태가 프로세스 메모리에 있어 수평 스케일(여러 인스턴스)은 불가능.
- **Jest 테스트에서 `destroy()` 경로**: `setInterval` cleanup 때문에 일부 test가 1~2초 더 걸릴 수 있음.

## License

MIT
