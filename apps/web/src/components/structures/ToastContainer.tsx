/*
Copyright 2024 New Vector Ltd.
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { createPortal } from "react-dom";
import classNames from "classnames";
import { IconButton, Text } from "@vector-im/compound-web";
import { type EmptyObject } from "matrix-js-sdk/src/matrix";
import { CloseIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import ToastStore, { type IToast } from "../../stores/ToastStore";
import { _t } from "../../languageHandler";

interface IState {
    toasts: IToast<any>[];
}

export default class ToastContainer extends React.Component<EmptyObject, IState> {
    public constructor(props: EmptyObject) {
        super(props);
        this.state = {
            toasts: ToastStore.sharedInstance().getToasts(),
        };
    }

    public componentDidMount(): void {
        ToastStore.sharedInstance().on("update", this.onToastStoreUpdate);
        this.onToastStoreUpdate();
    }

    public componentWillUnmount(): void {
        ToastStore.sharedInstance().removeListener("update", this.onToastStoreUpdate);
    }

    private onToastStoreUpdate = (): void => {
        this.setState({
            toasts: ToastStore.sharedInstance().getToasts(),
        });
    };

    public render(): React.ReactNode {
        const totalCount = this.state.toasts.length;
        const isStacked = totalCount > 1;
        let toast;
        let containerClasses;
        if (totalCount !== 0) {
            const topToast = this.state.toasts[0];
            const { title, icon, key, component, className, bodyClassName, onCloseButtonClicked, props } = topToast;
            const bodyClasses = classNames("mx_Toast_body", bodyClassName);
            const toastClasses = classNames("mx_Toast_toast", className, {
                mx_Toast_hasIcon: !!icon,
            });
            const toastProps = Object.assign({}, props, {
                key,
                toastKey: key,
            });
            const content = React.createElement(component, toastProps);

            let titleElement;
            if (title) {
                titleElement = (
                    <>
                        <div className="mx_Toast_title">
                            <Text size="lg" weight="semibold" as="h2">
                                {title}
                            </Text>
                        </div>
                        {onCloseButtonClicked && (
                            <IconButton
                                className="mx_Toast_closebutton"
                                size="28px"
                                onClick={onCloseButtonClicked}
                                tooltip={_t("action|close")}
                                kind="secondary"
                            >
                                <CloseIcon />
                            </IconButton>
                        )}
                    </>
                );
            }

            toast = (
                <div className={toastClasses}>
                    {icon}
                    {titleElement}
                    <div className={bodyClasses}>{content}</div>
                </div>
            );

            containerClasses = classNames("mx_ToastContainer", {
                mx_ToastContainer_stacked: isStacked,
            });
        }
        return toast
            ? createPortal(
                  <div className={containerClasses} role="alert">
                      {toast}
                  </div>,
                  getOrCreateContainer(),
              )
            : null;
    }
}

/**
 * The toasts are portalled to `<body>` rather than rendered where they sit in
 * the tree, because `#matrixchat` is `contain: strict` and so nothing inside it
 * can paint above the containers that are appended to the body - the call
 * widget among them. Rendered in place, a toast asking the user to verify their
 * device ends up underneath the call they are on.
 */
function getOrCreateContainer(): HTMLDivElement {
    let container = document.getElementById("mx_ToastContainer_container") as HTMLDivElement | null;
    if (!container) {
        container = document.createElement("div");
        container.id = "mx_ToastContainer_container";
        document.body.appendChild(container);
    }
    return container;
}
