import React, { useState, useEffect, useRef } from "react";

// Bootstrap
import Button from "react-bootstrap/Button";
import "bootstrap/dist/css/bootstrap.min.css";
import { BoxType } from "../../constants";

// Editor
import Editor from "@monaco-editor/react";
import { useFlowContext } from "../../providers/FlowProvider";
import { useProvenanceContext } from "../../providers/ProvenanceProvider";
import { useCollaborationContext } from "../../providers/CollaborationProvider";
import { ICodeData } from "../../types";

type CodeEditorProps = {
    setOutputCallback: any;
    data: any;
    output: ICodeData;
    boxType: BoxType;
    replacedCode: string; // code with all marks resolved
    sendCodeToWidgets: any;
    replacedCodeDirty: boolean;
    readOnly: boolean;
    defaultValue?: any;
    floatCode?: any;
};

function CodeEditor({
    setOutputCallback,
    data,
    output,
    boxType,
    replacedCode,
    sendCodeToWidgets,
    replacedCodeDirty,
    readOnly,
    defaultValue,
    floatCode,
}: CodeEditorProps) {
    const [code, setCode] = useState<string>(
        typeof defaultValue === "string" ? defaultValue : ""
    ); // code with all original markers

    const { workflowNameRef } = useFlowContext();
    const { boxExecProv } = useProvenanceContext();
    const { requestCodeChange } = useCollaborationContext();

    const replacedCodeDirtyBypass = useRef(false);
    const codeRef = useRef(code);
    const requestCodeChangeRef = useRef(requestCodeChange);
    const lastApprovedStampRef = useRef<number | undefined>(data?._approvedCodeStamp);

    useEffect(() => {
        codeRef.current = code;
    }, [code]);

    useEffect(() => {
        requestCodeChangeRef.current = requestCodeChange;
    }, [requestCodeChange]);

    // @ts-ignore
    const handleCodeChange = (value, event) => {
        setCode(value);
    };

    // Unified handler for both "defaultValue changed" (new shared code arrived
    // or the user navigated provenance) and "code-change proposal accepted".
    // Kept in a single effect because if defaultValue and the stamp change in
    // the same render two separate effects would each toggle markersDirty —
    // an even number of toggles cancels out, so WidgetsEditor never resolves
    // markers and the accepted code never runs.
    useEffect(() => {
        if (typeof defaultValue !== "string") return;
        const stamp = data?._approvedCodeStamp;
        const stampAdvanced = stamp !== undefined && stamp !== lastApprovedStampRef.current;

        if (stampAdvanced) {
            lastApprovedStampRef.current = stamp;
            setCode(defaultValue);
            setOutputCallback({ code: "exec", content: "" });
            sendCodeToWidgets(defaultValue);
        } else if (defaultValue !== code) {
            setCode(defaultValue);
            sendCodeToWidgets(defaultValue);
        }
    }, [defaultValue, data?._approvedCodeStamp]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (floatCode != undefined) floatCode(code);
    }, [code]);

    const commitCodeChange = () => {
        if (!readOnly && data?.nodeId) {
            requestCodeChangeRef.current(data.nodeId, codeRef.current);
        }
    };

    const processExecutionResult = (result: any) => {
        const stdout = typeof result?.stdout === "string" ? result.stdout : "";
        const stderr = typeof result?.stderr === "string" ? result.stderr : "";
        const savedPath = result?.output?.path;

        let outputContent = "";
        outputContent += "stdout:\n" + stdout.slice(0, 100);
        outputContent += "\nstderr:\n" + stderr;

        // outputContent += "\nnode output:\n";
        // if (outputContent.length > 100) {
        //     outputContent += result.codeOut.slice(0, 100) + "...";
        // }
        // else {
        //     outputContent += result.codeOut;
        // }

        if (savedPath) {
            outputContent += "\nSaved to file: " + savedPath;
        }

        if (stderr == "") {
            setOutputCallback({ code: "success", content: outputContent });
            // No error in the execution
            if (typeof data?.outputCallback === 'function') data.outputCallback(data.nodeId, result.output);
        } else {
            setOutputCallback({ code: "error", content: stderr });
        }
    };

    // marks were resolved and new code is available
    useEffect(() => {
        if (
            replacedCode != "" &&
            replacedCodeDirtyBypass.current &&
            output.code == "exec"
        ) {
            // the code was executing and not only resolving widgets
            // console.log(data);
            if (!readOnly && typeof defaultValue === "string" && code !== defaultValue) {
                requestCodeChangeRef.current(data.nodeId, code);
                setOutputCallback({
                    code: "warning",
                    content: "Code change is waiting for collaborator approval before it can run.",
                });
                return;
            }

            const interpreter = data?.pythonInterpreter;
            if (!interpreter || typeof interpreter.interpretCode !== "function") {
                setOutputCallback({
                    code: "error",
                    content: "Python interpreter is not available for this node. Try refreshing the workflow or re-adding the node.",
                });
                return;
            }

            interpreter.interpretCode(
                code,
                replacedCode,
                data.input,
                data.inputTypes,
                processExecutionResult,
                boxType,
                data.nodeId,
                workflowNameRef.current,
                boxExecProv
            );
        }

        replacedCodeDirtyBypass.current = true;
    }, [replacedCodeDirty]);

    useEffect(() => {
        // Save a reference to the original ResizeObserver
        const OriginalResizeObserver = window.ResizeObserver;

        // @ts-ignore
        window.ResizeObserver = function (callback) {
            const wrappedCallback = (entries: any, observer: any) => {
                window.requestAnimationFrame(() => {
                    callback(entries, observer);
                });
            };

            // Create an instance of the original ResizeObserver
            // with the wrapped callback
            return new OriginalResizeObserver(wrappedCallback);
        };

        // Copy over static methods, if any
        for (let staticMethod in OriginalResizeObserver) {
            if (
                Object.prototype.hasOwnProperty.call(
                    OriginalResizeObserver,
                    staticMethod
                )
            ) {
                // @ts-ignore
                window.ResizeObserver[staticMethod] = OriginalResizeObserver[staticMethod];
            }
        }
    }, []);

    return (
        <div className={"nowheel nodrag"} style={{ height: "100%" }}>
            <Editor
                language="python"
                theme="vs-dark"
                value={code}
                onChange={handleCodeChange}
                onMount={(editor) => {
                    editor.onDidBlurEditorText(commitCodeChange);
                }}
                options={{
                    // @ts-ignore
                    inlineSuggest: true,
                    fontSize: 8,
                    formatOnType: true,
                    // @ts-ignore
                    autoClosingBrackets: true,
                    minimap: { enabled: false },
                    readOnly: readOnly,
                }}
            />
            {/* <div
                className="nowheel"
                style={{ width: "100%", maxHeight: "200px", overflowY: "scroll" }}
            >
                {output == "success" ? "Done" : output == "exec" ? "Executing..." : output != "" ? "Error: "+output : ""}
            </div> */}
            {/* <Button
                as="a"
                variant="primary"
                onClick={() => {
                    setOutputCallback("exec");
                    sendCodeToWidgets(code); // will resolve markers
                }}
            >
                Run code
          </Button> */}
        </div>
    );
}

export default CodeEditor;
