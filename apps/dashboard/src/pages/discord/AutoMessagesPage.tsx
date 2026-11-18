import { PageTabs, useRememberedTab, type PageTab } from '../../components/PageTabs';
import { DiscordTimedMessages } from '../community/TimedMessagesPage';
import { StickyMessagesPage } from './StickyMessagesPage';

const TABS: ReadonlyArray<PageTab<'sticky' | 'timed'>> = [
  { id: 'sticky', label: 'Sticky' },
  { id: 'timed', label: 'Timed' },
];

/** Discord → Auto Messages: sticky messages (kept at the bottom of a channel) and timed messages (repeated in a channel). */
export function AutoMessagesPage() {
  const [tab, setTab] = useRememberedTab('conduit.autoMessagesTab', TABS);
  return (
    <PageTabs id="auto-messages" label="Auto messages" tabs={TABS} active={tab} onChange={setTab}>
      {tab === 'sticky' ? <StickyMessagesPage /> : <DiscordTimedMessages />}
    </PageTabs>
  );
}
