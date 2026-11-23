# 수집·운반 추정의 범위

비용표의 **처리비에는 현장에서 나가는 폐기물의 수집·운반비가 포함**된다. 공법별로 매각대금 차감 전 현장 일괄 견적을 입력하면 해당 공법의 처리·상차·운반 총액이 된다. 명시한 0원도 유효하다. 매각대금은 별도의 수익 항목으로 유지한다.

일괄 견적이 비어 있으면 중간처리비와 상차·운반 소계를 더한다. `assets/js/transport.js`는 중복 없는 반출 중량에 차량·거리별 단가를 적용한다. 공법별 현장 운반 견적이 있으면 이 소계를 대체한다. 공표 처리단가에 이미 포함된 처리 후 2차 폐기물 운반비는 다시 더하지 않는다.

## 근거

- [2026 건설폐기물 수집·운반비](https://data.cmpi.or.kr/program/board/%5B2026%EB%85%84%5D%20%EA%B1%B4%EC%84%A4%ED%8F%90%EA%B8%B0%EB%AC%BC%20%EC%88%98%EC%A7%91%C2%B7%EC%9A%B4%EB%B0%98%EB%B9%84.pdf), 자료제공 한국건설자원수집운반협회, 2026-01-01 적용. 건설폐재류의 덤프와 혼합폐기물의 암롤을 구분한다. 편도거리에 이미 왕복비가 반영된 원/t 단가이다. 상차와 운반을 나누고 VAT·중간처리비는 별도다.
- [2026 건설폐기물 성상별 중간처리단가](https://data.cmpi.or.kr/program/board/%5B2026%EB%85%84%5D%20%EA%B1%B4%EC%84%A4%ED%8F%90%EA%B8%B0%EB%AC%BC%20%EC%84%B1%EC%83%81%EB%B3%84%20%EC%A4%91%EA%B0%84%EC%B2%98%EB%A6%AC%EB%8B%A8%EA%B0%80.pdf)의 해설 ③은 배출현장의 수집운반비와 VAT를 제외한다. 건축물에서 별도 선별한 콘크리트와 가연물을 제거한 건설폐재류에는 각각 49,571원/t을 적용한다. 가연물 5% 이하 혼합건설폐기물에는 72,721원/t과 혼합폐기물 차량을 적용한다. 논현동의 시나리오는 이 세 경로의 콘크리트 중량비를 압쇄 66/26/8%, 분별 80/18/2%로 가정한다. 배분은 프로젝트 가정이며 공법별 처리·운반 일괄 견적을 입력하면 실제 견적 금액을 적용한다. 도로 구조물 전용 31,142원/t은 이 시나리오에 사용하지 않는다.
- [건설폐기물 업무처리지침](https://www.law.go.kr/admRulLsInfoP.do?admRulId=35894&efYd=0)의 처리업체 미확정 공공발주 참고조건을 따라, 거리가 비어 있으면 30km를 **가정**한다. 실제 현장거리라고 표시하지 않는다.
- [다산 자연재해위험개선지구 폐기물처리용역 2026년분 내역서](https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=R26BK01446429&bidPbancOrd=000&fileSeq=3&fileType=&prcmBsneSeCd=03)는 덤프24t·30km 운반비16,450원/t과 처리비·VAT를 별도 계상한 공공사례다. 사례는 단가 사용을 대조하는 자료이며 이 사이트 대상 현장의 실제 견적이 아니다.

## 계산과 확인할 가정

30km 이하는 30km 요금, 표 사이 거리는 직선보간한다. 60km 초과는 공표표 주8이 지정한 50~60km의 기울기로 가산하며 `extrapolated:true`를 기록한다. 예를 들어24t덤프70km는 운반31,550원/t과 상차3,890원/t이다. 원거리일수록 현장견적을 우선해야 한다.

분리 목재·수지·보드 등에는 혼합폐기물과 같은 실제 적재비중이나 수용처가 확인되어 있지 않다. 기본 `separatedHandling:'benchmark'`는 혼합 암롤 단가를 명시적 대리가정으로 사용하며 `isProxy`와 경고를 남긴다. `'quote'`를 선택하면 이 경로는 미산정으로 남긴다. 매각물의 기본값은 `salvageHandling:'unknown'`이다. 매입자 수거가 확인된 경우에만 `'buyer-pickup'` 또는 경로별 `pickupIncluded:true`로 현장 부담0원을 적용한다.

상차가 기존 장비비·처리계약에 포함되면 `loadingIncluded:true`로 상차만 제외한다. 운반 전체가 포함된 경로에는 `pickupIncluded:true`를 사용한다. 전체공법 운반견적을 입력하면 추가 표준추정을 더하지 않는다. 현장선별·처리장 내 운반·후속 폐기물 운반을 여기에서 다시 계산하지 않는다.

암롤24t의 표준 용적과 적재비중으로 계산한 참고 적재량은18.9t이다. `referenceLoads`와 `referenceDispatches`는 적재조건 검토용이며 운반비를 여기에 다시 곱하지 않는다. 공표값은 톤당 요금이므로 소량 최소배차료나 별도 운행·대기료를 추가로 추정하지 않고 확인항목으로 남긴다. 이 수량은 혼적·합차·법적 운행가능성의 확정값이 아니다.

반환 `complete`는 공급받은 모든 경로의 금액 또는 수거조건을 정산했다는 뜻이다. 현장 실측 검증을 뜻하지 않는다. `publishedDistanceSensitivity`는 동일 중량을30km/60km 표에 대입한 비교이며 비용 신뢰구간이 아니다.

## 연동

`estimateTransport({routes,quote,...q.transport})`를 사용한다. `routes`는 `{key,label,stream,tons,kind,destination,receiver?,distanceKm?,truck?,quote?,pickupIncluded?}` 배열이다. 성상은`mineral|mixed|separated`, 목적지는`disposal|salvage`이다. 같은`key`가 중복되면 두 번째 중량은 합산하지 않고 오류로 남긴다.

반환은`{total,status,complete,rows,issues,unpriced,assumptions,sources,benchmark,routeTons,publishedDistanceSensitivity}`이다. 내보내기에는 가정·미산정 경로도 보관해야 한다. `TRANSPORT_SOURCE`, `TRANSPORT_METHOD`, `TRANSPORT_RATES`를 화면의 출처·기준 설명에 사용할 수 있다.
