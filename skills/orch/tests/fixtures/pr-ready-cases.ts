// 실제 띄우기 기록과 완료 감시가 같은 지시서 표본을 검증한다.
const review = 'worker 선택: `claude` `m` effort `기본`. 행: review. 비교: codex. 이유: 리뷰.'
export const prReadyCases = [
  { name: '리뷰 행', text: review, skip: true },
  { name: '머지하지 않는 지시', text: '5. 머지하지 않는다. PR 주소를 status 로 보낸다.', skip: true },
  { name: '닫는 괄호 번호', text: '1) 머지하지 않는다.', skip: true },
  { name: '머지하지 않지만 준비 보고가 필요한 지시', text: '5. 머지하지 않는다.\n## 완료 기준\n- `준비됨 #PR` 을 보낸다.', skip: false },
  { name: '리뷰지만 준비 보고가 필요한 지시', text: `${review}\n## 완료 기준\n### 보고\n- 준비됨 을 보낸다.`, skip: false },
  { name: '완료 기준 밖의 준비 보고 언급', text: '머지하지 않는다.\n## 완료 기준\n- PR 주소를 보낸다.\n## 배경\n준비됨 은 다른 작업의 신호다.', skip: true },
  { name: '인용한 배경', text: '- 배경: 지시서에 「머지하지 않는다」 가 있는 작업을 고친다.', skip: false },
  { name: '인용 블록', text: '> 머지하지 않는다.', skip: false },
  { name: '활용형', text: '머지하지 않는다고 설명한다.', skip: false },
  { name: '코디네이터가 머지', text: '머지는 코디네이터가 한다.', skip: false },
  { name: '코드 예시의 머지 지시', text: '```text\n머지하지 않는다.\n```', skip: false },
  { name: '코드 예시의 리뷰 행', text: `~~~text\n${review}\n~~~`, skip: false },
  { name: '코드 예시의 준비 보고', text: '머지하지 않는다.\n## 완료 기준\n```text\n준비됨 을 보낸다.\n```\n- PR 주소를 보낸다.', skip: true },
  { name: '보통 구현', text: '완료 기준: 준비됨 status 를 보낸다.', skip: false },
]
