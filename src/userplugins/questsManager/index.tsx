/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 X2 Salah and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button } from "@components/Button";
import definePlugin from "@utils/types";

import { toggleQuestsManager, unmountQuestsManager } from "./manager";
import { PLUGIN_VERSION_LABEL } from "./version";

export default definePlugin({
    name: "Quests Manager",
    description: `Discord Quest Auto Completer (${PLUGIN_VERSION_LABEL})`,
    authors: [{
        name: "X2 Salah",
        id: 0n
    }],

    patches: [
        {
            find: ".PlatformTypes.WEB",
            replacement: {
                match: /(\((\i)\){)(let{leading)/,
                replace: "$1$2?.trailing?.props?.children?.unshift($self.renderQuestsManagerButton());$3"
            }
        }
    ],

    start() {},

    stop() {
        unmountQuestsManager();
    },

    renderQuestsManagerButton() {
        return (
            <Button
                variant="primary"
                size="small"
                onClick={() => toggleQuestsManager()}
                style={{ marginInlineEnd: 8 }}
            >
                Quests Manager
            </Button>
        );
    }
});
