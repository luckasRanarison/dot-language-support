import * as lst from "vscode-languageserver-types";
import { DiagnosticMessage, SourceFile, DiagnosticCategory } from "../types";
import { formatError, diagnosicSource } from "../error";
import { DocumentLike } from "../";

function convertDiagnostic(document: DocumentLike, source: DiagnosticMessage): lst.Diagnostic {
	return {
		range: {
			start: document.positionAt(source.start),
			end: document.positionAt(source.end),
		},
		severity: source.category,
		code: formatError(source.code),
		source: diagnosicSource,
		message: source.message,
	};
}

export function validateDocument(doc: DocumentLike, sourceFile: SourceFile): lst.Diagnostic[] {
	const diagnostics = sourceFile.diagnostics;
	if (!diagnostics || diagnostics.length <= 0)
		return [];

	return diagnostics.map(d => convertDiagnostic(doc, d));
}
