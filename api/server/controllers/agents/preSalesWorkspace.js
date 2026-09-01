const { randomUUID } = require('node:crypto');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const db = require('~/models');

const ROOT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';
const MAX_DOCUMENT_CHARS = 120000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function safeTitle(value) {
  return String(value || 'Pre-Sales Lead')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1024);
}

function buildWorkspacePrompt({ title, document, context }) {
  const prospect = context?.prospect || {};
  const lines = [
    'DBM PRE-SALES STRATEGY WORKSPACE',
    '',
    `Lead workspace: ${title}`,
    prospect.name ? `Lead: ${prospect.name}` : null,
    prospect.companyName ? `Company: ${prospect.companyName}` : null,
    prospect.city || prospect.state
      ? `Market: ${[prospect.city, prospect.state].filter(Boolean).join(', ')}`
      : null,
    context?.strategyCallAt ? `Strategy Call: ${context.strategyCallAt}` : null,
    context?.primaryAngle ? `Primary angle: ${context.primaryAngle}` : null,
    document?.url ? `Pre-Call Google Doc: ${document.url}` : null,
    '',
    'SPECIAL INSTRUCTIONS FOR THIS CONVERSATION:',
    '- Act as April Edwards and Jack\'s live sales strategist for this specific lead.',
    '- Treat the attached/preloaded Pre-Call Intelligence document below as the factual source of truth.',
    '- Help them prepare for the call, identify the strongest sales angles, anticipate objections, formulate discovery questions, choose proof points, and decide what NOT to say.',
    '- When asked for a call plan, prioritize the highest-leverage path to winning the client rather than repeating the whole report.',
    '- Distinguish facts from hypotheses. Never invent facts about the lead, company, budget, competitors, or intent.',
    '- Tailor recommendations to the prospect and DBM\'s actual capabilities. Optimize for trust, relevance, and closing probability rather than pressure tactics.',
    '- If April or Jack asks a question that the document cannot answer, say what is unknown and propose the best question to ask the prospect on the call.',
    '',
    `DOCUMENT: ${document?.title || 'Pre-Call Intelligence'}`,
    document?.text
      ? String(document.text).slice(0, MAX_DOCUMENT_CHARS)
      : 'The document text could not be mirrored automatically. Use the Google Doc link above as the external reference.'
  ].filter((line) => line !== null);

  return lines.join('\n');
}

async function findOwnerByEmail(email) {
  return runAsSystem(async () => {
    if (typeof db.findUser === 'function') {
      return db.findUser({ email });
    }
    if (typeof db.findUsers === 'function') {
      const result = await db.findUsers({ email }, null, 1);
      return Array.isArray(result) ? result[0] : result?.users?.[0] || null;
    }
    return null;
  });
}

async function findExistingConversation(userId, title) {
  try {
    const result = await db.getConvosByCursor(userId, {
      limit: 10,
      search: title,
      sortBy: 'updatedAt',
      sortDirection: 'desc'
    });
    const conversations = result?.conversations || result?.data || [];
    return conversations.find((item) => item?.title === title) || null;
  } catch {
    return null;
  }
}

async function createPreparedPreSalesWorkspace(req, res) {
  const expectedSecret = process.env.LIBRECHAT_PRE_SALES_SERVICE_KEY;
  const suppliedSecret = req.get('x-pre-sales-service-key');
  if (!expectedSecret || !suppliedSecret || suppliedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized pre-sales workspace request' });
  }

  const ownerEmail = normalizeEmail(req.body?.ownerEmail);
  const title = safeTitle(req.body?.title);
  const agentId = String(req.body?.agentId || '').trim();
  const document = req.body?.document || {};
  const context = req.body?.context || {};

  if (!ownerEmail || !agentId || !title) {
    return res.status(400).json({ error: 'ownerEmail, title and agentId are required' });
  }

  try {
    const owner = await findOwnerByEmail(ownerEmail);
    if (!owner) {
      return res.status(404).json({ error: `LibreChat user not found: ${ownerEmail}` });
    }

    const userId = String(owner.id || owner._id);
    let conversation = await findExistingConversation(userId, title);
    let created = false;

    if (!conversation) {
      const conversationId = randomUUID();
      conversation = await db.saveConvo(
        {
          userId,
          isTemporary: false,
          interfaceConfig: {}
        },
        {
          conversationId,
          title,
          endpoint: 'agents',
          model: agentId,
          agent_id: agentId
        },
        { context: 'POST /api/agents/v1/responses/pre-sales/conversations' }
      );

      const userMessageId = randomUUID();
      const workspacePrompt = buildWorkspacePrompt({ title, document, context });
      await db.saveMessage(
        {
          userId,
          isTemporary: false,
          interfaceConfig: {}
        },
        {
          messageId: userMessageId,
          conversationId,
          parentMessageId: ROOT_MESSAGE_ID,
          isCreatedByUser: true,
          sender: owner.name || owner.username || owner.email || 'Strategy',
          text: workspacePrompt,
          endpoint: 'agents',
          model: agentId,
          user: userId
        },
        { context: 'pre-sales workspace seed user message' }
      );

      await db.saveMessage(
        {
          userId,
          isTemporary: false,
          interfaceConfig: {}
        },
        {
          messageId: randomUUID(),
          conversationId,
          parentMessageId: userMessageId,
          isCreatedByUser: false,
          sender: 'DBM Sales Strategist',
          text:
            'Pre-sales workspace ready. I have the lead brief and Pre-Call Intelligence loaded. Ask me how to prepare, what to prioritize, likely objections, discovery questions, positioning, or how to win this specific Strategy Call.',
          endpoint: 'agents',
          model: agentId,
          user: userId,
          unfinished: false,
          error: false
        },
        { context: 'pre-sales workspace seed assistant message' }
      );
      created = true;
    }

    const conversationId = conversation.conversationId;
    const baseUrl = String(process.env.DOMAIN_CLIENT || '').replace(/\/+$/, '');
    return res.status(created ? 201 : 200).json({
      created,
      conversationId,
      title,
      ownerEmail,
      documentUrl: document?.url || null,
      documentMirrored: Boolean(document?.text),
      url: baseUrl ? `${baseUrl}/c/${conversationId}` : `/c/${conversationId}`
    });
  } catch (error) {
    logger.error('[PreSalesWorkspace] Failed to create prepared conversation', error);
    return res.status(500).json({ error: 'Failed to create prepared pre-sales conversation' });
  }
}

module.exports = { createPreparedPreSalesWorkspace };
