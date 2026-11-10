// 머지를 worker 에게 알리는 글. 마무리(queue/finish-pr.ts)와 루프(loop/steps/merged.ts)가 같은 글을 보낸다.
// 머지 뒤에 할 일이 남았는지는 그 worker 의 지시서만 안다. 스크립트가 판단하지 않고 지시서의 완료 기준을 따르게 한다.
// 「다음 PR」 은 넣지 않는다. 지시서 하나가 PR 하나를 맡고 다음 PR 은 코디네이터가 새 worker 로 띄운다.

export function mergeNotice(pr: number | string, commit: string): string {
  const where = commit ? `(머지 커밋 ${commit})` : ''
  return `PR #${pr} 이 MERGED 됐다${where}. gh pr view 로 확인한다. 지시서의 완료 기준에 머지 뒤에 할 일이 남았으면 그 일을 마친 뒤에, 없으면 바로 worker_done 을 보내고 끝낸다.`
}
