// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - that gives them Passwords' autofill (see
// electron/passwords.mts).
//
// It finds login fields, and when the user puts the cursor in one, tells
// main where the field is, so the desktop can show the vault's logins for
// the site below it; the login picked comes back here to be typed in. A
// login the user types and submits is reported too, for the desktop to
// offer to save. Nothing of the vault is ever handed to the page except the
// login the user picks.
//
// Verification code fields are reported too, for the desktop to offer the
// codes from the user's texts (electron/phone-codes.mts): one field, or a
// row of one-digit boxes, which the code picked is spread across.
//
// So are payment card fields, for the vault's cards. The card picked comes
// to every frame of the page on the asking frame's site or the page's own
// (a checkout's card number, expiry and code may each be in a frame of the
// payment provider's), and each fills the card fields it shows.
//
// The page's own frame also says where in it one of its frames is, for the
// desktop to put the list beside a field in that frame.
//
// Stays in the isolated world: the page can't see or call any of this. It
// can see the events filling dispatches, which is what makes its own
// scripts notice the values, and the values themselves, as it would had
// they been typed.
//
// Registered with session.registerPreloadScript in main.mts, so it runs in
// every frame of web pages, each on its own.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  /** The login field the cursor is in, or was last. */
  /** @type {HTMLInputElement | null} */
  let current = null;
  /** Whether the desktop is showing suggestions for `current`, and one is highlighted. */
  let shown = false;
  let highlighted = false;
  /** Filling: the focus and input events it causes aren't the user's. */
  let filling = false;
  /** Password fields the user typed in, or that got a generated password. */
  /** @type {WeakSet<HTMLInputElement>} */
  const typed = new WeakSet();
  /** @type {WeakSet<HTMLInputElement>} */
  const generated = new WeakSet();
  /** The username typed on an earlier step (sites that ask for it on a page of its own). */
  let earlierUsername = '';
  let lastSubmitted = { password: '', at: 0 };

  /** @param {Element | null} el */
  const visible = (el) => !!el && el.getClientRects().length > 0;

  /** @param {EventTarget | null} el @returns {el is HTMLInputElement} */
  const isInput = (el) => el instanceof HTMLInputElement;

  /** @param {HTMLInputElement} input */
  const hints = (input) => `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`;

  /** @param {HTMLInputElement} input */
  const scopeOf = (input) => input.form ?? document;

  /** @param {Document | HTMLFormElement} scope */
  const passwordFields = (scope) =>
    /** @type {HTMLInputElement[]} */ ([...scope.querySelectorAll('input[type=password]')]).filter(
      // A card's code hidden as a password isn't one.
      (i) => !i.disabled && visible(i) && !cardKind(i),
    );

  /**
   * Whether a password field says what it's for: a new password (true), the
   * current one (false), or nothing (null).
   * @param {HTMLInputElement} input
   * @returns {boolean | null}
   */
  const saysNewPassword = (input) => {
    const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
    if (autocomplete.includes('current-password')) return false;
    if (autocomplete.includes('new-password')) return true;
    if (/new|confirm|repeat|again|re-?type|re-?enter|signup|sign-up|register|create/i.test(hints(input))) return true;
    return null;
  };

  /**
   * Whether a password field takes a new password. One that doesn't say is
   * new when it shares its form with others that don't say either (a new
   * password and its confirmation) or with the current one (changing it);
   * beside only fields that say they're new, it's the login's own: pages
   * wrapped whole in one form (ASP.NET's) sign in and sign up in the same one.
   * @param {HTMLInputElement} input
   */
  const isNewPassword = (input) => {
    const says = saysNewPassword(input);
    if (says !== null) return says;
    if (!input.form) return false;
    return passwordFields(input.form).some((other) => other !== input && saysNewPassword(other) !== true);
  };

  /**
   * What kind of login field this is, if it is one.
   * @param {EventTarget | null} el
   * @returns {'username' | 'password' | 'new-password' | null}
   */
  const loginKind = (el) => {
    if (!isInput(el) || el.disabled || el.readOnly) return null;
    if (el.type === 'password') return isNewPassword(el) ? 'new-password' : 'password';
    if (el.type !== 'text' && el.type !== 'email' && el.type !== 'tel') return null;
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/\b(username|webauthn)\b/.test(autocomplete)) return 'username';
    if (passwordFields(scopeOf(el)).length === 0) return null;
    if (/\bemail\b/.test(autocomplete) || el.type === 'email') return 'username';
    return /user|e-?mail|login|account|identifier|phone/i.test(hints(el)) ? 'username' : null;
  };

  /** Codes that aren't the one a text brings. */
  const NOT_VERIFICATION = /zip|postal|post[-_ ]?code|promo|coupon|voucher|gift|discount|country|area[-_ ]?code|referr|invit|captcha|tracking|product|sku|color|colour|swift|sort[-_ ]?code|bank|cvc|cvv|card|phone|mobile/i;

  /** @param {HTMLInputElement} input */
  const codeHints = (input) => `${hints(input)} ${input.autocomplete} ${[...(input.labels ?? [])].map((l) => l.textContent ?? '').join(' ')}`;

  /** @param {EventTarget | null} el @returns {el is HTMLInputElement} */
  const isCodeInput = (el) =>
    isInput(el) && !el.disabled && !el.readOnly && (el.type === 'text' || el.type === 'tel' || el.type === 'number');

  /**
   * The row of one-digit boxes a code goes in, if this is one of them: four
   * to ten of them side by side, in the box's nearest container that holds
   * them all.
   * @param {HTMLInputElement} input
   * @returns {HTMLInputElement[] | null}
   */
  const codeBoxes = (input) => {
    if (input.maxLength !== 1) return null;
    let container = input.parentElement;
    for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
      const boxes = /** @type {HTMLInputElement[]} */ ([...container.querySelectorAll('input')]).filter(
        (i) => isCodeInput(i) && i.maxLength === 1 && visible(i),
      );
      if (boxes.length >= 4 && boxes.length <= 10) return boxes;
      if (boxes.length > 10) return null;
    }
    return null;
  };

  /**
   * Whether this is where a verification code goes: a field that says so
   * (autocomplete="one-time-code", or a name like "otp" or "verification
   * code"), or a row of one-digit boxes.
   * @param {EventTarget | null} el
   * @returns {el is HTMLInputElement}
   */
  const isCodeField = (el) => {
    if (!isCodeInput(el)) return false;
    const autocomplete = el.autocomplete.toLowerCase();
    if (autocomplete.includes('one-time-code')) return true;
    if (/\b(username|email|current-password|new-password|cc-|postal-code|tel)\b/.test(autocomplete)) return false;
    const text = codeHints(el);
    if (NOT_VERIFICATION.test(text)) return false;
    if (codeBoxes(el)) return true;
    if (el.maxLength > 0 && (el.maxLength < 4 || el.maxLength > 12)) return false;
    return /otp|one[-_ ]?time|verif|2fa|mfa|two[-_ ]?(factor|step)|passcode|sms[-_ ]?code|security[-_ ]?code|auth\w*[-_ ]?code|confirm\w*[-_ ]?code|login[-_ ]?code|sign[-_ ]?in[-_ ]?code|\bcode\b|\bpin\b|token/i.test(text);
  };

  /** What a card field takes, by its autocomplete token. */
  const CARD_TOKENS = new Set(['cc-name', 'cc-given-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc']);

  /** @param {HTMLInputElement | HTMLSelectElement} el */
  const fieldHints = (el) =>
    `${el.name} ${el.id} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${[...(el.labels ?? [])].map((l) => l.textContent ?? '').join(' ')}`.toLowerCase();

  /** Card fields by their names and labels, where they don't say (autocomplete). */
  const CARD_HINTS = /** @type {[RegExp, string][]} */ ([
    [/card.?num|cc.?num|cardnum|credit.?card|debit.?card|kartennummer|num[eé]ro.?de.?(la.?)?carte|n[uú]mero.?de.?(la.?)?tarjeta/, 'cc-number'],
    [/cvc|cvv|csc|security.?code|card.?code|card.?verif|kartenpr[uü]f/, 'cc-csc'],
    [/exp\w*.?month|month.?exp|cc.?month|exp.?mm\b/, 'cc-exp-month'],
    [/exp\w*.?year|year.?exp|cc.?year|exp.?yy/, 'cc-exp-year'],
    [/expir|exp.?date|valid.?(thru|until)|mm.?\/.?yy|ablauf/, 'cc-exp'],
    [/name.?on.?card|card.?holder|cardholder|cc.?name|karteninhaber|titular/, 'cc-name'],
  ]);

  /** @param {Element} el */
  const cardScope = (el) => /** @type {HTMLInputElement | HTMLSelectElement} */ (el).form ?? document;

  /**
   * What a payment card field takes, if it is one: what it says
   * (autocomplete), or what its names say in a form that has a field for a
   * card's number.
   * @param {EventTarget | null} el
   * @param {boolean} [named] Already checked that the form has a number field.
   * @returns {string | null}
   */
  const cardKind = (el, named = false) => {
    const isSelect = el instanceof HTMLSelectElement;
    if (!isSelect && !isInput(el)) return null;
    const field = /** @type {HTMLInputElement | HTMLSelectElement} */ (el);
    if (field.disabled || (isInput(field) && (field.readOnly || !['text', 'tel', 'number', 'search', 'password'].includes(field.type)))) return null;
    const tokens = (field.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    const said = tokens.find((t) => CARD_TOKENS.has(t));
    if (said) return said;
    if (tokens.some((t) => t && t !== 'off' && t !== 'on')) return null;
    const text = fieldHints(field);
    const hinted = CARD_HINTS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
    if (!hinted || hinted === 'cc-number') return hinted;
    // "Security code" and the like are a card's only beside a card's number.
    if (named) return hinted;
    const scope = cardScope(field);
    return [...scope.querySelectorAll('input')].some((i) => i !== field && cardKind(i, true) === 'cc-number') ? hinted : null;
  };

  /**
   * What kind of field the autofill offers something for, if any. A card
   * field is offered cards from a text field (a select is only filled).
   * @param {EventTarget | null} el
   * @returns {'username' | 'password' | 'new-password' | 'one-time-code' | 'card' | null}
   */
  const fieldKind = (el) => (isInput(el) && cardKind(el) ? 'card' : isCodeField(el) ? 'one-time-code' : loginKind(el));

  /**
   * The field a username goes in, for a password field (the last text field before it).
   * @param {HTMLInputElement} password
   */
  const usernameFor = (password) => {
    const fields = /** @type {HTMLInputElement[]} */ ([...scopeOf(password).querySelectorAll('input')]);
    let best = null;
    for (const field of fields) {
      if (field === password) break;
      if (!field.disabled && visible(field) && (loginKind(field) === 'username' || field.type === 'email' || field.type === 'text')) {
        best = field;
      }
    }
    return best;
  };

  /** @param {HTMLInputElement} input */
  const report = (input) => {
    const kind = fieldKind(input);
    if (!kind) return;
    current = input;
    const r = input.getBoundingClientRect();
    ipcRenderer.send('passwords:field', {
      kind,
      rect: {
        x: r.left / innerWidth,
        y: r.top / innerHeight,
        width: r.width / innerWidth,
        height: r.height / innerHeight,
      },
    });
  };

  const hide = () => {
    if (!shown) return;
    shown = false;
    ipcRenderer.send('passwords:blur');
  };

  /**
   * Type a value in the way the page's own scripts notice.
   * @param {HTMLInputElement} input @param {string} value
   */
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** A login form's field to fill, when the cursor isn't in one (the browser's toolbar). */
  const firstLoginField = () => {
    const password = passwordFields(document)[0];
    if (password) return password;
    return /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input')]).find(
      (i) => visible(i) && loginKind(i) === 'username',
    ) ?? null;
  };

  /** Report a login being submitted, if the user typed (or generated) its password. */
  /** @param {Document | HTMLFormElement} scope */
  const submitted = (scope) => {
    const fields = passwordFields(scope).filter((i) => i.value && (typed.has(i) || generated.has(i)));
    if (fields.length === 0) return;
    // A form with a new password (signing up, changing it) saves the new one.
    const password = fields.find(isNewPassword) ?? fields[0];
    const usernameField = usernameFor(fields[0]);
    const username = usernameField?.value.trim() || earlierUsername;
    if (password.value === lastSubmitted.password && Date.now() - lastSubmitted.at < 3000) return;
    lastSubmitted = { password: password.value, at: Date.now() };
    ipcRenderer.send('passwords:submitted', { username, password: password.value });
  };

  /** Whether the field lost the keyboard with the whole page, not to another field in it. */
  let pageBlurred = false;

  document.addEventListener('focusin', (event) => {
    if (!event.isTrusted || filling) return;
    // The page getting the keyboard back (after a click on the suggestions) isn't the user going into the field.
    if (pageBlurred && event.target === current) {
      pageBlurred = false;
      return;
    }
    pageBlurred = false;
    if (fieldKind(event.target)) report(/** @type {HTMLInputElement} */ (event.target));
  }, true);

  // A click on the desktop's suggestions takes the keyboard from the page
  // before the click lands, so a field left focused in a page that lost focus
  // only says so, and the desktop decides whether the suggestions stay.
  document.addEventListener('focusout', (event) => {
    if (event.target !== current) return;
    const field = current;
    setTimeout(() => {
      if (document.activeElement === field && !document.hasFocus()) {
        pageBlurred = true;
        if (shown) ipcRenderer.send('passwords:page-blur');
      } else {
        pageBlurred = false;
        if (field === current) hide();
      }
    });
  }, true);

  // A click in the field it's already in brings the suggestions back.
  document.addEventListener('pointerdown', (event) => {
    if (event.isTrusted && current && event.target === current && document.activeElement === current && !shown) report(current);
  }, true);

  document.addEventListener('input', (event) => {
    if (!event.isTrusted || filling || !isInput(event.target)) return;
    const input = event.target;
    if (input.type === 'password') typed.add(input);
    else if (loginKind(input) === 'username') earlierUsername = input.value.trim();
    if (input === current) hide();
  }, true);

  addEventListener('scroll', hide, { capture: true, passive: true });
  addEventListener('resize', hide, { passive: true });

  addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.target !== current || !current) return;
    const key = event.key;
    if (shown && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Escape' || (key === 'Enter' && highlighted))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send('passwords:key', key);
      if (key === 'Escape') shown = false;
      return;
    }
    if (!shown && key === 'ArrowDown') report(current);
    if (key === 'Enter') submitted(scopeOf(current));
  }, true);

  document.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) submitted(event.target);
  }, true);

  // Plenty of sites log in from a script on a button's click, not a submit.
  // Only buttons that say so: not the eye that shows the password.
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest('button, input[type=submit], input[type=button], [role=button]');
    if (!button) return;
    const label = `${button.textContent ?? ''} ${button.getAttribute('value') ?? ''} ${button.getAttribute('aria-label') ?? ''}`;
    if (button.getAttribute('type') !== 'submit' && !/log\s?in|sign\s?(in|up)|continue|next|submit|register|create|save|enter/i.test(label)) return;
    submitted(button.closest('form') ?? document);
  }, true);

  ipcRenderer.on('passwords:shown', (_event, /** @type {{ visible: boolean, highlighted: boolean }} */ state) => {
    shown = state.visible;
    highlighted = state.highlighted;
  });

  // A code from a text arrived: up come the suggestions, if the cursor's in a code field.
  ipcRenderer.on('passwords:code-arrived', () => {
    if (current?.isConnected && document.hasFocus() && document.activeElement === current && isCodeField(current)) report(current);
  });

  ipcRenderer.on('passwords:fill-code', (_event, /** @type {{ code: string }} */ { code }) => {
    const anchor = current?.isConnected && isCodeField(current) ? current : null;
    if (!anchor || typeof code !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(code)) return;
    filling = true;
    try {
      const boxes = codeBoxes(anchor);
      if (boxes && boxes.length >= code.length) {
        // Widgets made of boxes mostly take a paste in the first and spread it
        // themselves; if this one doesn't, one character a box, as if typed
        // into each in turn.
        const data = new DataTransfer();
        data.setData('text/plain', code);
        boxes[0].focus();
        const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        if (!boxes[0].dispatchEvent(paste) && boxes.every((box, i) => box.value === (code[i] ?? ''))) return;
        boxes.forEach((box, i) => {
          box.focus();
          type(box, code[i] ?? '');
        });
        boxes[Math.min(code.length, boxes.length) - 1].focus();
      } else {
        type(anchor, code);
        anchor.focus();
      }
    } finally {
      filling = false;
      pageBlurred = !document.hasFocus();
    }
  });

  /**
   * Choose the option of a select that stands for a value: by its value or
   * its text, as a number where both are ("01", "1", "January").
   * @param {HTMLSelectElement} select @param {string[]} candidates
   */
  const choose = (select, candidates) => {
    const wanted = candidates.map((c) => c.toLowerCase());
    const option = [...select.options].find((o) => {
      const value = o.value.trim().toLowerCase();
      const label = (o.textContent ?? '').trim().toLowerCase();
      return wanted.some((w) => value === w || label === w || (/^\d+$/.test(w) && (Number(value) === Number(w) || Number(label) === Number(w))));
    });
    if (!option) return;
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  /**
   * An expiry in the form a field asks for: "MM/YY" mostly; "MM / YY",
   * "MM/YYYY" or "MMYY" where its placeholder or length says so.
   * @param {HTMLInputElement} input @param {string} mm @param {string} yyyy
   */
  const expiryFor = (input, mm, yyyy) => {
    const hint = (input.getAttribute('placeholder') ?? '').toLowerCase();
    const yy = yyyy.slice(-2);
    if (/yyyy|aaaa|jjjj/.test(hint) || input.maxLength === 7) return `${mm}/${yyyy}`;
    if (input.maxLength === 4) return `${mm}${yy}`;
    if (/\s\/\s/.test(hint)) return `${mm} / ${yy}`;
    return `${mm}/${yy}`;
  };

  ipcRenderer.on('passwords:fill-card', (_event, /** @type {{ holder: string, number: string, expMonth: string, expYear: string, code: string, asking: boolean }} */ card) => {
    if (!card || typeof card.number !== 'string' || !/^\d{12,19}$/.test(card.number)) return;
    const fields = /** @type {(HTMLInputElement | HTMLSelectElement)[]} */ ([...document.querySelectorAll('input, select')]).filter(
      (f) => visible(f) && cardKind(f),
    );
    if (fields.length === 0) return;
    const [given, ...rest] = card.holder.split(/\s+/);
    const mm = card.expMonth;
    const yyyy = card.expYear;
    filling = true;
    try {
      for (const field of fields) {
        const kind = cardKind(field);
        if (field instanceof HTMLSelectElement) {
          if (kind === 'cc-exp-month' && mm) choose(field, [mm, String(Number(mm)), MONTHS[Number(mm) - 1] ?? '', (MONTHS[Number(mm) - 1] ?? '').slice(0, 3)]);
          else if (kind === 'cc-exp-year' && yyyy) choose(field, [yyyy, yyyy.slice(-2)]);
          continue;
        }
        const input = /** @type {HTMLInputElement} */ (field);
        const value =
          kind === 'cc-number' ? card.number
          : kind === 'cc-csc' ? card.code
          : kind === 'cc-name' ? card.holder
          : kind === 'cc-given-name' ? given ?? ''
          : kind === 'cc-family-name' ? rest.join(' ')
          : kind === 'cc-exp' ? (mm && yyyy ? expiryFor(input, mm, yyyy) : '')
          : kind === 'cc-exp-month' ? mm
          : kind === 'cc-exp-year' ? (input.maxLength === 2 ? yyyy.slice(-2) : yyyy)
          : '';
        if (value) type(input, value);
      }
    } finally {
      // Back in the field it was asked from, for the user to carry on.
      if (card.asking && current?.isConnected) current.focus();
      filling = false;
      pageBlurred = !document.hasFocus();
    }
  });

  // The page's own frame, asked where one of its frames is: found by its
  // name, or else its address, if just one matches.
  if (window === window.top) {
    ipcRenderer.on('passwords:locate-frame', (_event, /** @type {{ id: number, name: string, url: string }} */ ask) => {
      const frames = /** @type {HTMLIFrameElement[]} */ ([...document.querySelectorAll('iframe, frame')]);
      const absolute = (/** @type {string} */ src) => {
        try {
          return new URL(src, location.href).href;
        } catch {
          return '';
        }
      };
      let matches = ask.name ? frames.filter((f) => f.name === ask.name) : [];
      if (matches.length !== 1) matches = frames.filter((f) => f.src && absolute(f.src) === ask.url);
      const frame = matches.length === 1 && visible(matches[0]) ? matches[0] : null;
      let rect = null;
      if (frame) {
        const r = frame.getBoundingClientRect();
        // The frame's content, inside its border.
        const x = r.left + frame.clientLeft;
        const y = r.top + frame.clientTop;
        rect = { x: x / innerWidth, y: y / innerHeight, width: frame.clientWidth / innerWidth, height: frame.clientHeight / innerHeight };
      }
      ipcRenderer.send('passwords:frame-located', { id: ask.id, rect });
    });
  }

  ipcRenderer.on('passwords:fill', (_event, /** @type {{ username: string | null, password: string, generated: boolean }} */ login) => {
    const anchor = current?.isConnected ? current : firstLoginField();
    if (!anchor) return;
    filling = true;
    try {
      if (login.generated) {
        for (const field of passwordFields(scopeOf(anchor)).filter(isNewPassword)) {
          type(field, login.password);
          generated.add(field);
        }
        return;
      }
      const anchorKind = loginKind(anchor);
      // From the username, its login's password: the first after it, in a form that holds more than one login.
      const logins = passwordFields(scopeOf(anchor)).filter((f) => !isNewPassword(f));
      const password = anchorKind === 'password' || anchorKind === 'new-password'
        ? anchor
        : logins.find((f) => anchor.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) ?? logins[0] ?? null;
      const username = anchorKind === 'username' ? anchor : password ? usernameFor(password) : null;
      if (login.username && username) type(username, login.username);
      if (password) type(password, login.password);
    } finally {
      // Back in the field, for Enter to sign in: a click on the suggestions took the keyboard.
      if (anchor === current) anchor.focus();
      filling = false;
      // Unless the page is yet to get the keyboard back, which isn't the user going into the field either.
      pageBlurred = !document.hasFocus();
    }
  });
}
