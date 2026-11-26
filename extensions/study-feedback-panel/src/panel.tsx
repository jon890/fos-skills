import {
  atom, Badge, Box, Button, Callout, Card, Collapsible, EmptyState, Heading, Input,
  Link, plugin, read, Row, set, Stack, Tab, Tabs, Text, update, type PanelContext
} from 'orca'
import type {} from './protocol.ts'
import { ANSWERS, needsReason, validReason, type Action, type Answer, type Choice } from './choices.ts'
import type { ChoiceError, Screen } from './state.ts'
import type { FeedbackCard, StudyCard, Summary } from './summary.ts'

const screen = atom<Screen | null>(null)
const loadFailed = atom(false)
const draft = atom<{ choice: Choice; reason: string } | null>(null)
const requestErrors = atom<Record<string, { revision: number; message: string }>>({})
const pending = atom<Record<string, boolean>>({})
const label: Record<Answer, string> = {
  write: '글로 쓰기', later: '나중에', drop: '빼기', apply: '반영', hold: '보류', reject: '기각'
}
const fileNotice = {
  missing: '요약 파일 없음',
  unsupported: '요약 파일 형식 버전 불일치',
  read_failed: '읽기 실패',
  unconfigured: '설정에서 fosbot 홈의 절대 경로를 입력해 주세요.'
}
const errors: Record<ChoiceError, string> = {
  unconfigured: '플러그인 설정에서 fosbot 홈과 전용 자동화를 확인해 주세요.',
  unavailable: '최신 요약을 읽을 수 없어 보내지 못했습니다.',
  changed: '후보가 갱신되었습니다. 새 내용을 확인해 주세요.',
  invalid_choice: '이 후보에 보낼 수 없는 선택입니다.',
  invalid_reason: '이유를 한 줄로 입력해 주세요.',
  locked: '앞서 보낸 선택을 확인 중입니다.',
  duplicate: '같은 선택을 최근 1분 안에 보냈습니다.',
  queue_write_failed: '요청을 대기열에 쓰지 못했습니다.',
  wake_failed: 'fosbot을 깨우지 못했습니다.'
}
const date = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23'
})
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
})
const keyOf = (action: Action, item: string) => JSON.stringify([action, item])

function accept(next: Screen) {
  update(screen, (current) => current && current.sequence >= next.sequence ? current : next)
  set(loadFailed, false)
}

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(plugin.on('studyPanel.changed', accept))
  void plugin.request('studyPanel.get', undefined, { signal: ctx.signal }).then(accept, () => {
    if (!ctx.signal.aborted && !read(screen)) set(loadFailed, true)
  })
}

async function send(choice: Choice) {
  const key = keyOf(choice.action, choice.item)
  if (read(pending)[key]) return
  update(pending, (items) => ({ ...items, [key]: true }))
  update(requestErrors, (items) => {
    const next = { ...items }
    delete next[key]
    return next
  })
  let message: string | undefined
  try {
    const result = await plugin.request('studyPanel.choose', choice, { timeoutMs: 45_000 })
    accept(result.screen)
    if ('error' in result) message = errors[result.error]
    else {
      const active = read(draft)?.choice
      if (active && active.revision === choice.revision && active.answer === choice.answer &&
          keyOf(active.action, active.item) === key) set(draft, null)
    }
  } catch {
    message = '전송 결과를 확인하지 못했습니다. 카드 상태를 확인해 주세요.'
  } finally {
    update(pending, (items) => {
      const next = { ...items }
      delete next[key]
      return next
    })
  }
  if (message) update(requestErrors, (items) => ({ ...items, [key]: { revision: choice.revision, message } }))
}

function actions(card: StudyCard | FeedbackCard, action: Action, current: Screen) {
  const key = keyOf(action, card.id)
  const statuses = current.cards.filter((entry) => entry.action === action &&
    entry.item === card.id && entry.revision === card.revision)
  const sending = read(pending)[key] || statuses.some((entry) => entry.status === 'sending')
  const previous = statuses.find((entry) => entry.sentAt)
  const disabled = current.status !== 'ready' || !current.configured ||
    card.state !== 'selectable' || sending || previous?.status === 'sent'
  const input = read(draft)
  const active = input?.choice.action === action && input.choice.item === card.id &&
    input.choice.revision === card.revision ? input : null
  const failure = read(requestErrors)[key]
  return (
    <Stack gap="sm">
      {card.state === 'recorded' && <Badge tone="neutral">답 기록됨</Badge>}
      {sending && <Text muted>보내는 중</Text>}
      {previous?.status === 'sent' && previous.sentAt &&
        <Badge tone="success">{'보냄 ' + time.format(Date.parse(previous.sentAt))}</Badge>}
      {!sending && previous?.status === 'waiting' && <Badge tone="warning">처리 대기</Badge>}
      {card.error && <Callout tone="danger">{card.error.message}</Callout>}
      {failure?.revision === card.revision && <Callout tone="danger">{failure.message}</Callout>}
      <Row gap="xs" wrap>
        {ANSWERS[action].map((answer, index) => {
          const choice = { action, item: card.id, revision: card.revision, answer }
          return <Button key={answer} size="sm" variant={index === 0 ? 'solid' : 'outline'}
            tone={index === 0 ? 'accent' : 'neutral'} disabled={disabled}
            onPress={() => needsReason(answer) ? set(draft, { choice, reason: '' }) : send(choice)}>
            {label[answer]}
          </Button>
        })}
      </Row>
      {active && (
        <Stack gap="xs">
          <Input label={label[active.choice.answer] + ' 이유'} value={active.reason} disabled={disabled}
            onChange={(reason) => set(draft, { choice: active.choice, reason })}
            onSubmit={(reason) => {
              if (!disabled && validReason(reason)) return send({ ...active.choice, reason })
            }} />
          <Row gap="xs">
            <Button size="sm" tone="accent" disabled={disabled || !validReason(active.reason)}
              onPress={() => send({ ...active.choice, reason: active.reason })}>보내기</Button>
            <Button size="sm" variant="ghost" onPress={() => set(draft, null)}>취소</Button>
          </Row>
        </Stack>
      )}
    </Stack>
  )
}

function studyCard(card: StudyCard, current: Screen) {
  return (
    <Card key={card.id} title={card.title}>
      <Stack gap="sm">
        <Text>{card.question}</Text>
        {card.outline.length > 0 && (
          <Collapsible title="개요">
            <Stack gap="xs">
              {card.outline.map((line, index) => <Text key={index}>{line}</Text>)}
            </Stack>
          </Collapsible>
        )}
        {card.sources.length > 0 && (
          <Stack gap="xs">
            <Text size="xs" muted>출처</Text>
            {card.sources.map(({ label, url }, index) => (
              <Text key={index} size="sm">
                {url && /^https?:\/\//i.test(url) ? <Link href={url}>{label}</Link> : label}
              </Text>
            ))}
          </Stack>
        )}
        {actions(card, 'choose_study_candidate', current)}
      </Stack>
    </Card>
  )
}

function feedbackCard(card: FeedbackCard, current: Screen, repoName: (id: string) => string) {
  return (
    <Card key={card.id} title={card.number + '. ' + card.title} description={card.skill}>
      <Stack gap="sm">
        {card.candidates.map((candidate) => (
          <Row key={candidate.id} gap="xs" wrap>
            <Text size="sm">{candidate.title}</Text>
            <Text size="xs" muted>{repoName(candidate.repoId)}</Text>
          </Row>
        ))}
        {actions(card, 'choose_feedback_bundle', current)}
      </Stack>
    </Card>
  )
}

function showSummary(summary: Summary, current: Screen) {
  const repositories = new Map(summary.repositories.map(({ id, name }) => [id, name]))
  const repoName = (id: string) => repositories.get(id) ?? '요약에 저장소 이름 없음'
  const countedRepos = summary.repositories.filter((repo) => repo.studyCount > 0 || repo.feedbackCount > 0)
  return (
    <>
      <Row gap="xs" wrap>
        <Badge tone="accent">{'공부 ' + summary.study.length}</Badge>
        <Badge tone="accent">{'피드백 묶음 ' + summary.feedback.length}</Badge>
        <Badge tone="neutral">{'진행 중 ' + summary.inProgress.length}</Badge>
      </Row>
      {summary.inProgress.length > 0 && (
        <Stack gap="xs">
          <Heading level={3}>진행 중</Heading>
          {summary.inProgress.map((work) => (
            <Card key={work.activity + ':' + work.item} title={work.title}>
              <Row gap="xs" wrap>
                <Text size="sm">{work.activity === 'writing' ? '글 쓰는 중' : '반영 요청 중'}</Text>
                <Text size="sm" muted>{repoName(work.repoId)}</Text>
                {work.pr && <Badge tone="neutral">{'PR #' + work.pr.number + ' · ' + (work.pr.draft ? '초안' : '열림')}</Badge>}
              </Row>
            </Card>
          ))}
        </Stack>
      )}
      <Tabs label="공부·피드백 목록" defaultValue="study">
        <Tab value="study" label="오늘의 공부">
          <Stack gap="sm">
            {summary.study.length ? summary.study.map((item) => studyCard(item, current))
              : <EmptyState title="오늘 고를 공부 후보가 없어요" />}
          </Stack>
        </Tab>
        <Tab value="feedback" label="스킬 피드백">
          <Stack gap="sm">
            <Row gap="xs" wrap>
              <Badge tone="neutral">{'기각 ' + summary.feedbackTotals.rejected}</Badge>
              <Badge tone="neutral">{'보류 ' + summary.feedbackTotals.held}</Badge>
            </Row>
            {summary.feedback.length ? summary.feedback.map((item) => feedbackCard(item, current, repoName))
              : <EmptyState title="오늘 고를 피드백 묶음이 없어요" />}
          </Stack>
        </Tab>
        <Tab value="repos" label="저장소별">
          <Stack gap="xs">
            {countedRepos.length ? countedRepos.map((repo) => (
              <Card key={repo.id} title={repo.name}>
                <Text>{'공부 ' + repo.studyCount + ' · 피드백 ' + repo.feedbackCount}</Text>
              </Card>
            )) : <EmptyState title="집계한 저장소가 없어요" />}
          </Stack>
        </Tab>
      </Tabs>
    </>
  )
}

export default function Panel() {
  const current = read(screen)
  if (!current) return read(loadFailed)
    ? <Callout tone="danger">패널을 불러오지 못했습니다. 패널을 다시 열어 주세요.</Callout>
    : <Text muted>요약을 읽는 중</Text>
  return (
    <Box direction="column" gap="sm" padding="sm">
      <Row gap="xs" wrap>
        <Text size="xs" muted>
          {current.curatedAt ? '마지막 정리 ' + date.format(Date.parse(current.curatedAt)) : '마지막 정리 기록 없음'}
        </Text>
        {current.stale && <Badge tone="warning">오래됨</Badge>}
      </Row>
      {current.status !== 'ready' && <Callout tone="warning">{fileNotice[current.status]}</Callout>}
      {current.status === 'ready' && !current.configured && (
        <Callout tone="warning">{errors.unconfigured}</Callout>
      )}
      {current.summary && showSummary(current.summary, current)}
    </Box>
  )
}
