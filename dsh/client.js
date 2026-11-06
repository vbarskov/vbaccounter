window.__ModuleLoader__.load({
	id: "vbaccounter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var react_dom = require("react-dom");
		var jsx_runtime = require("react/jsx-runtime");

		//#region lib/types/client/index.js
		/** Маршрут host-части: та же константа, что в lib/index.js. */
		var STATUS_PATH = "/vbaccounter/status";

		/** Подписи для кодов сервиса. */
		var APPLICABILITY = { required: "требуется", unknown: "неизвестна", "not-required": "не требуется" };
		var LIFECYCLE = {
			"needs-data": "нужны данные",
			prepared: "подготовлен",
			sent: "отправлен",
			accepted: "принят",
			rejected: "отказ",
			pending: "ожидает",
			paid: "оплачен",
			done: "выполнено"
		};
		var KIND = { filing: "отчёт", payment: "платёж", check: "проверка" };
		var TAX_REGIME = { simplified: "упрощённый режим", general: "общий режим", unknown: "режим неизвестен" };

		/**
		 * Подпись чипа по сводке статуса.
		 * @param {object|null} value - ответ маршрута статуса.
		 * @returns {string} короткая подпись для шапки сессии.
		 */
		function formatChip(value) {
			if (!value || !value.counts) return "VB • …";
			var counts = value.counts;
			var parts = [];
			if (counts.overdue > 0) parts.push(counts.overdue + " просроч.");
			if (counts.week > 0) parts.push(counts.week + " ≤7д");
			else if (counts.fortnight > 0) parts.push(counts.fortnight + " ≤14д");
			if (counts.unknown > 0) parts.push(counts.unknown + " ?");
			if (parts.length === 0) parts.push(value.total > 0 ? value.total + " в работе" : "чисто");
			return "VB • " + parts.join(" • ");
		}

		/**
		 * Человекочитаемый срок.
		 * @param {{days: number|null}} item - элемент сводки.
		 * @returns {string} срок словами.
		 */
		function whenText(item) {
			if (typeof item.days !== "number") return "срок не задан";
			if (item.days < 0) return "просрочено на " + Math.abs(item.days) + " дн.";
			if (item.days === 0) return "сегодня";
			return "через " + item.days + " дн.";
		}

		/**
		 * Подписи измерения для одного обязательства.
		 * @param {object} item - нормализованное обязательство.
		 * @returns {string} строка вида «отчёт · требуется · нужны данные».
		 */
		function labels(item) {
			var parts = [];
			if (item.kind) parts.push(KIND[item.kind] || item.kind);
			if (item.applicability) parts.push(APPLICABILITY[item.applicability] || item.applicability);
			if (item.lifecycle) parts.push(LIFECYCLE[item.lifecycle] || item.lifecycle);
			return parts.join(" · ");
		}

		/**
		 * Привести обязательство сервиса к общему виду для карточки и панели.
		 * @param {object} item - обязательство из `vb_list_obligations`.
		 * @returns {object} нормализованное обязательство.
		 */
		function normalizeItem(item) {
			var days = item.urgency && typeof item.urgency.daysUntilDue === "number" ? item.urgency.daysUntilDue : typeof item.days === "number" ? item.days : null;
			return {
				id: item.id || "",
				title: item.title || "",
				due: item.due || null,
				days: days,
				kind: item.kind || "",
				applicability: item.applicability || "",
				lifecycle: item.lifecycle || "",
				account: item.accountName || item.account || "",
				authority: item.authority || "",
				period: item.period || "",
				nextAction: item.nextAction || ""
			};
		}

		/**
		 * Одна строка обязательства: срок и название, ниже — адресат, период и статусы.
		 * @param {object} item - нормализованное обязательство.
		 * @returns {object} React-элемент строки.
		 */
		function itemRow(item) {
			var head = (item.due ? item.due + " · " : "") + item.title + " — " + whenText(item);
			var meta = [item.authority, item.period, labels(item)].filter(Boolean).join(" · ");
			var children = [jsx_runtime.jsx("div", { children: head })];
			if (meta) {
				children.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-caption, inherit)", fontSize: "11px" }, children: meta }));
			}
			return jsx_runtime.jsx("div", { style: { display: "flex", flexDirection: "column", gap: "1px", padding: "2px 0" }, children: children });
		}

		/** Прочитать сводку статуса и обновлять её раз в минуту. */
		function useStatus() {
			var state = react.useState({ status: "loading" });
			var value = state[0];
			var setValue = state[1];
			react.useEffect(function () {
				var cancelled = false;
				async function load() {
					try {
						var response = await fetch(STATUS_PATH, { credentials: "same-origin" });
						if (!response.ok) throw new Error("HTTP " + response.status);
						var body = await response.json();
						if (!cancelled) setValue({ status: "ready", value: body });
					} catch (error) {
						if (!cancelled) setValue({ status: "failed", message: error instanceof Error ? error.message : String(error) });
					}
				}
				load();
				var timer = setInterval(load, 60000);
				return function () {
					cancelled = true;
					clearInterval(timer);
				};
			}, []);
			return value;
		}

		/** Стиль чипа в шапке сессии. */
		function chipStyle(failed) {
			return {
				display: "inline-flex",
				alignItems: "center",
				padding: "2px 9px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35))",
				background: "rgba(127, 127, 127, 0.10)",
				color: failed ? "var(--dsw-alias-state-error-primary, rgb(220, 90, 90))" : "inherit",
				font: "inherit",
				fontSize: "11px",
				whiteSpace: "nowrap",
				cursor: "pointer"
			};
		}

		/** Пилюля-счётчик в раскрытой панели. */
		function counterChip(label, value, warn) {
			return jsx_runtime.jsx("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					padding: "1px 8px",
					borderRadius: "999px",
					border: "1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35))",
					color: warn ? "var(--dsw-alias-state-warn-label, rgb(214, 140, 40))" : "var(--dsw-alias-label-secondary, inherit)"
				},
				children: label + ": " + value
			});
		}

		/** Пилюля-счётчик внутри карточки ленты. */
		function pillStyle(warn) {
			return {
				display: "inline-flex",
				alignItems: "center",
				padding: "1px 8px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.35))",
				color: warn ? "var(--dsw-alias-state-warn-label, rgb(214, 140, 40))" : "var(--dsw-alias-label-secondary, inherit)",
				whiteSpace: "nowrap"
			};
		}

		/**
		 * Разложить обязательства по группам срочности.
		 * @param {object[]} items - нормализованные обязательства.
		 * @returns {{title: string, rows: object[]}[]} непустые группы по порядку.
		 */
		function groupItems(items) {
			var groups = [
				{ title: "Просрочено", rows: [] },
				{ title: "Ближайшие 7 дней", rows: [] },
				{ title: "Ближайшие 14 дней", rows: [] },
				{ title: "Позже", rows: [] },
				{ title: "Без срока", rows: [] }
			];
			for (var index = 0; index < items.length; index += 1) {
				var item = items[index];
				var target = groups[4];
				if (typeof item.days === "number") {
					if (item.days < 0) target = groups[0];
					else if (item.days <= 7) target = groups[1];
					else if (item.days <= 14) target = groups[2];
					else target = groups[3];
				}
				target.rows.push(item);
			}
			return groups.filter(function (group) { return group.rows.length > 0; });
		}

		/** Заголовок группы в панели. */
		function groupTitle(text) {
			return jsx_runtime.jsx("div", {
				style: { color: "var(--dsw-alias-label-caption, inherit)", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "10px", marginTop: "2px" },
				children: text
			});
		}

		/**
		 * Раскрытая панель статусов: компания, счётчики, все обязательства по группам.
		 * @param {object|null} value - сводка статуса.
		 * @param {string|null} failed - сообщение ошибки, если данные не получены.
		 * @param {Function} close - закрыть панель.
		 * @returns {object} React-элемент панели.
		 */
		function statusPanel(value, failed, close) {
			var children = [];
			children.push(jsx_runtime.jsx("div", {
				style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" },
				children: [
					jsx_runtime.jsx("strong", { children: "VB Accounter" }),
					jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-caption, inherit)", whiteSpace: "nowrap" }, children: value && value.asOf ? "на " + value.asOf : "" })
				]
			}));
			if (failed) {
				children.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-state-error-primary, rgb(220, 90, 90))" }, children: failed }));
			} else if (value) {
				var accounts = (value.accounts || []).map(function (account) {
					if (typeof account === "string") return account;
					return account.name + (account.taxRegime ? " · " + (TAX_REGIME[account.taxRegime] || account.taxRegime) : "");
				});
				if (accounts.length > 0) {
					children.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-secondary, inherit)" }, children: accounts.join("; ") }));
				}
				var counts = value.counts || {};
				children.push(jsx_runtime.jsx("div", {
					style: { display: "flex", flexWrap: "wrap", gap: "4px" },
					children: [
						counterChip("просрочено", counts.overdue || 0, (counts.overdue || 0) > 0),
						counterChip("≤7 дней", counts.week || 0, false),
						counterChip("≤14 дней", counts.fortnight || 0, false),
						counterChip("применимость ?", counts.unknown || 0, (counts.unknown || 0) > 0),
						counterChip("нужны данные", counts.needsData || 0, false)
					]
				}));
				var items = (Array.isArray(value.items) ? value.items : []).map(normalizeItem);
				if (items.length === 0) {
					children.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-caption, inherit)" }, children: "Активных обязательств нет." }));
				}
				var groups = groupItems(items);
				for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
					var rows = groups[groupIndex].rows.map(function (item) { return itemRow(item); });
					children.push(jsx_runtime.jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "2px" },
						children: [groupTitle(groups[groupIndex].title)].concat(rows)
					}));
				}
				var tail = [];
				if (value.unread > 0) tail.push("непрочитанных уведомлений: " + value.unread);
				if (value.settings && typeof value.settings.enabled === "boolean") {
					var lead = Array.isArray(value.settings.leadDays) ? value.settings.leadDays.join("/") : "";
					tail.push("напоминания: " + (value.settings.enabled ? "включены" : "выключены") + (lead ? " · за " + lead + " дн." : ""));
				}
				if (tail.length > 0) {
					children.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-caption, inherit)" }, children: tail.join(" · ") }));
				}
			}
			children.push(jsx_runtime.jsx("div", {
				style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", color: "var(--dsw-alias-label-caption, inherit)" },
				children: [
					jsx_runtime.jsx("span", { children: "локальный реестр · Esc — закрыть" }),
					jsx_runtime.jsx("button", {
						type: "button",
						onClick: close,
						style: { background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: "14px", lineHeight: "1", padding: "0 2px" },
						children: "×"
					})
				]
			}));
			return jsx_runtime.jsx("div", {
				style: {
					position: "fixed",
					top: "56px",
					right: "16px",
					zIndex: 1000,
					width: "380px",
					maxHeight: "70vh",
					overflowY: "auto",
					background: "var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-base, #2b2b2b))",
					border: "1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35))",
					borderRadius: "10px",
					boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
					padding: "10px 12px",
					display: "flex",
					flexDirection: "column",
					gap: "8px",
					fontSize: "12px",
					lineHeight: "17px",
					textAlign: "left",
					whiteSpace: "normal",
					color: "var(--dsw-alias-label-primary, inherit)"
				},
				children: children
			});
		}

		/** Чип статуса в шапке сессии: по клику раскрывает панель. */
		function StatusChip() {
			var state = useStatus();
			var openState = react.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			react.useEffect(function () {
				if (!open) return undefined;
				function close() { setOpen(false); }
				function onKey(event) { if (event.key === "Escape") close(); }
				document.addEventListener("click", close);
				document.addEventListener("keydown", onKey);
				return function () {
					document.removeEventListener("click", close);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			var value = state.status === "ready" ? state.value : null;
			var failed = state.status === "failed";
			var label = failed ? "VB • нет связи" : formatChip(value) + (open ? " ▴" : " ▾");
			var button = jsx_runtime.jsx("button", {
				type: "button",
				onClick: function (event) { event.stopPropagation(); setOpen(!open); },
				title: failed ? "VB Accounter: " + state.message : "VB Accounter: открыть статусы и сроки",
				style: chipStyle(failed),
				children: label
			});
			var wrapper = [button];
			if (open) {
				// Панель монтируется в body: шапка чата не должна обрезать или перекрывать её.
				wrapper.push(react_dom.createPortal(statusPanel(value, failed ? state.message : null, function () { setOpen(false); }), document.body));
			}
			return jsx_runtime.jsx("span", { style: { position: "relative", display: "inline-flex" }, children: wrapper });
		}

		/** Общий стиль карточки в ленте чата. */
		function cardStyle(failed) {
			return {
				border: "1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.35))",
				borderRadius: "10px",
				background: "var(--dsw-alias-bg-base, rgba(127, 127, 127, 0.06))",
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				fontSize: "13px",
				lineHeight: "18px",
				color: failed ? "var(--dsw-alias-state-error-primary, rgb(220, 90, 90))" : "inherit"
			};
		}

		/**
		 * Текст результата tool-call из блоков конверсации.
		 * @param {object} block - settled-блок вызова.
		 * @returns {string|null} склеенный текст результата.
		 */
		function resultText(block) {
			if (!block || !("kind" in block)) return null;
			var parts = [];
			var content = Array.isArray(block.content) ? block.content : [];
			for (var index = 0; index < content.length; index += 1) {
				var item = content[index];
				parts.push(item && item.type === "text" ? item.text : JSON.stringify(item));
			}
			return parts.join("\n") || null;
		}

		/**
		 * Разобрать состояние вызова: выполняется, ошибка или JSON-результат.
		 * @param {object} block - блок tool-call из ленты.
		 * @returns {{phase: string, value?: object, message?: string}} состояние строки.
		 */
		function toolState(block) {
			if (!block || !("kind" in block)) return { phase: "running" };
			var text = resultText(block);
			if (block.isError) return { phase: "failed", message: text || "ошибка вызова" };
			var value = block.structuredContent && typeof block.structuredContent === "object" ? block.structuredContent : null;
			if (!value && text) {
				try { value = JSON.parse(text); } catch (error) { value = null; }
			}
			return { phase: "ready", value: value };
		}

		/**
		 * Счётчики по нормализованным обязательствам.
		 * @param {object[]} items - нормализованные обязательства.
		 * @returns {{overdue: number, week: number, fortnight: number, unknown: number, needsData: number}} счётчики.
		 */
		function countItems(items) {
			var counts = { overdue: 0, week: 0, fortnight: 0, unknown: 0, needsData: 0 };
			for (var index = 0; index < items.length; index += 1) {
				var item = items[index];
				if (typeof item.days === "number") {
					if (item.days < 0) counts.overdue += 1;
					else if (item.days <= 7) counts.week += 1;
					else if (item.days <= 14) counts.fortnight += 1;
				}
				if (item.applicability === "unknown") counts.unknown += 1;
				if (item.lifecycle === "needs-data") counts.needsData += 1;
			}
			return counts;
		}

		/** Карточка статусов для вызова `vb_list_obligations` прямо в ленте чата. */
		function ObligationsCard(props) {
			var state = toolState(props.block);
			if (state.phase === "running") {
				return jsx_runtime.jsx("div", { style: cardStyle(false), children: "VB Accounter: читаю обязательства…" });
			}
			if (state.phase === "failed") {
				return jsx_runtime.jsx("div", { style: cardStyle(true), children: "VB Accounter: " + state.message });
			}
			var value = state.value;
			if (!value || !Array.isArray(value.obligations)) {
				return jsx_runtime.jsx("div", { style: cardStyle(false), children: "VB Accounter: список обязательств" });
			}
			var items = value.obligations.filter(function (item) { return !item.closed; }).map(normalizeItem);
			var counts = countItems(items);
			var chips = [];
			if (counts.overdue > 0) chips.push(jsx_runtime.jsx("span", { style: pillStyle(true), children: "просрочено: " + counts.overdue }));
			if (counts.week > 0) chips.push(jsx_runtime.jsx("span", { style: pillStyle(false), children: "≤7 дней: " + counts.week }));
			if (counts.fortnight > 0) chips.push(jsx_runtime.jsx("span", { style: pillStyle(false), children: "≤14 дней: " + counts.fortnight }));
			if (counts.unknown > 0) chips.push(jsx_runtime.jsx("span", { style: pillStyle(true), children: "применимость ?: " + counts.unknown }));
			if (counts.needsData > 0) chips.push(jsx_runtime.jsx("span", { style: pillStyle(false), children: "нужны данные: " + counts.needsData }));
			if (chips.length === 0) chips.push(jsx_runtime.jsx("span", { style: pillStyle(false), children: "нет активных обязательств" }));
			var shown = items.slice(0, 8);
			var lines = shown.map(function (item) { return itemRow(item); });
			if (lines.length === 0) {
				lines.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-caption, inherit)" }, children: "Активных обязательств нет." }));
			}
			var head = jsx_runtime.jsx("div", {
				style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
				children: [
					jsx_runtime.jsx("strong", { children: "VB Accounter" }),
					jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-caption, inherit)" }, children: "всего в реестре: " + items.length + (value.asOf ? " · на " + value.asOf : "") })
				]
			});
			var body = [head, jsx_runtime.jsx("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: chips })];
			body.push(jsx_runtime.jsx("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: lines }));
			if (items.length > shown.length) {
				body.push(jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-caption, inherit)" }, children: "и ещё " + (items.length - shown.length) + " — откройте панель в шапке сессии" }));
			}
			return jsx_runtime.jsx("div", {
				style: cardStyle(false),
				"data-tool": "vb_list_obligations",
				children: body
			});
		}

		/** Требуемый сервис: реестр слотов. */
		var inject = ["slots"];

		/**
		 * Зарегистрировать карточку в ленте чата и чип в шапке сессии.
		 * @param {object} ctx - клиентский контекст с `ctx.slots`.
		 */
		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", function () {
				return ctx.slots.register({ name: "tool.call.toolview", key: "mcp__vbaccounter__vb_list_obligations" }, ObligationsCard);
			});
			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({ name: "conversation.session.header.actions", id: "vbaccounter-status", order: 100 }, StatusChip);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.formatChip = formatChip;
		return module.exports;
	}
});
