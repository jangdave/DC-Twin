# ADR-003: 서비스 방식은 Pixel Streaming 주력 + exe 기준선, UI는 혼합안

- 상태: 채택 (UI 분배는 E4 후 확정)
- 날짜: 2026-10-15

## 결정
- 주력 Pixel Streaming(PixelStreaming2), 기준선 Windows 패키징, 비교 대상 ovrtx 뷰어.
- UI는 UMG/CommonUI 기본 + 일부 패널을 웹으로 구현해 데이터 채널로 연동하는 **혼합안**.
- 제외: 모바일 네이티브, XR.

## 근거
- 운영 화면은 설치 없이 브라우저로 접속할 수 있어야 하고 단말 사양과 무관해야 한다.
- 클라이언트 C++/UMG 역량을 중심으로 보여주되, 웹 연동 설계 능력도 증명한다.

## 한계
- 스트림 압축으로 텍스트가 흐려질 수 있음 → 텍스트 중심 패널은 웹 쪽 후보.
- 라이브 데모는 GPU 서버 가동이 필요 → 영상 기본, 라이브는 시연용. 호스팅 세부 전략은 [ADR-004](ADR-004-streaming-hosting.md).
- Unreal과 별도로 가벼운 웹(WebGL) 보기 화면을 추가하는 안은 [ADR-011](ADR-011-webgl-viewer.md)에서 다룬다(2026-11-02, 초안).
- Gateway는 MQTT 클라이언트 라이브러리 없이 UE가 데이터를 받게 하는 선택(WebSocket 변환)이다.
