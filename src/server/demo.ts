import {MessageSchema, TaskChangeSchema} from '../shared/schema.js';
import {Store, now} from './store.js';

export function seedDemo(store: Store) {
  store.setMeta('demo', true);
  if (store.snapshot().tasks.length) return;
  const settings = store.settings();
  store.saveSettings({settings: {...settings, chats: [
    {id: 'design', name: 'Design team', sessionId: 'sample', chatId: 'design-sample', enabled: true},
    {id: 'product', name: 'Product team', sessionId: 'sample', chatId: 'product-sample', enabled: true},
    {id: 'alex', name: 'Alex Morgan', sessionId: 'sample', chatId: 'alex-sample', enabled: true},
  ]}, secrets: {}, removeSecrets: []});
  const items = [
    {title:'Review the onboarding flow before Friday', scope:'Website refresh', chat:'design-sample', body:'Could you take a look at the new onboarding flow? The first screen still asks for a lot. Let’s simplify it before Friday’s review.', note:'The design team wants a simpler first step before the upcoming review. Focus on what someone needs to get started.', steps:['Walk through the first three screens as a new user.','Share a proposal that removes the nonessential fields.'], criteria:['The team has reviewed the proposed first step.','Required fields are limited to what’s needed to get started.'], priority:'high', state:'ready'},
    {title:'Share the updated project timeline',scope:'Q4 planning',chat:'product-sample',body:'Can you share the updated milestones in the planning doc? It would help us see the dependencies before we commit to dates.',note:'The product team needs a clear view of milestones and dependencies before agreeing on dates.',steps:['Update the planning document with the latest milestones.','Highlight dependencies that could change the timeline.'],criteria:['The team can see current milestones and dependencies.'],priority:'normal',state:'ready'},
    {title:'Send Alex the notes from our conversation',scope:'Team follow-ups',chat:'alex-sample',body:'Thanks for the chat! Could you send over your notes so I can check we’re thinking about the same next steps?',note:'Alex asked for a written recap of the conversation and its next steps.',steps:['Summarize the decisions and open questions.','Share the recap with Alex for review.'],criteria:['Alex has received the recap.'],priority:'normal',state:'ready'},
    {title:'Check the mobile navigation spacing',scope:'Website refresh',chat:'design-sample',body:'The mobile menu feels a little cramped on smaller phones. Can we check the tap targets before the next handover?',note:'The design team flagged cramped mobile navigation. Check the smallest supported screen and keep controls easy to tap.',steps:['Check the navigation at the smallest supported width.','Adjust spacing around the menu and action buttons.'],criteria:['Navigation controls have comfortable tap targets.','The page has no horizontal overflow.'],priority:'normal',state:'ready'},
    {title:'Confirm which metrics belong in the weekly report',scope:'Reporting',chat:'product-sample',body:'We should agree on the weekly report metrics. Are we tracking activation, retention, or both? Let’s decide before the template is finalized.',note:'The weekly report template depends on the team agreeing which metrics it should cover.',steps:['Ask the team to confirm activation, retention, or both.'],criteria:['The report’s metric scope is agreed and recorded.'],priority:'normal',state:'needs_info'},
    {title:'Follow up on the illustration handover',scope:'Website refresh',chat:'design-sample',body:'The illustrator is preparing the final files. I’ll let you know once the exports are ready for review.',note:'The final illustration exports are being prepared. Review can begin once the files are shared.',steps:['Review the final exports when the illustrator shares them.'],criteria:['Final illustration files have been reviewed.'],priority:'low',state:'waiting'},
    {title:'Organize the shared reference library',scope:'Design operations',chat:'design-sample',body:'Could we tidy the shared reference library and group the onboarding examples together?',note:'Group the onboarding references so the team can find them in one place.',steps:['Collect the onboarding examples into one folder.'],criteria:['The team can find onboarding examples in the shared library.'],priority:'normal',state:'ready'},
  ];
  for (const [i,item] of items.entries()) {
    const message = MessageSchema.parse({id:`sample-message-${i}`,sessionId:'sample',chatId:item.chat,waMessageId:`sample-${i}`,body:item.body,direction:'incoming',type:'text',timestamp:now() - 3600 - i*1800});
    store.cache([message]);
    store.apply([TaskChangeSchema.parse({id:null,title:item.title,scope:item.scope,note:item.note,source_ids:[message.id],action_steps:item.steps,done_when:item.criteria,priority:item.priority,triage_state:item.state,blocking_question:item.state==='needs_info'?'Should the weekly report include activation, retention, or both?':null})],[message]);
  }
  const completed = store.snapshot().tasks.find(t=>t.title==='Organize the shared reference library');
  if(completed)store.tick(completed.id,true);
  store.status({phase:'Sample workspace · no live chats or AI calls',last_poll:now(),syncing:false,error:null});
}
