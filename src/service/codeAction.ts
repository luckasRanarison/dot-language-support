import * as lst from "vscode-languageserver-types";
import { DocumentLike, SourceFile, DiagnosticMessage, ErrorSource, CheckErrorCode, ParseError, ParseErrorCode, ScanErrorCode, CheckError, SyntaxKind, CommandApplication, Graph, forEachChild, isIdentifierNode, SyntaxNode, EdgeStatement, SyntaxNodeFlags } from "../";
import { assertNever, getStart } from "./util";
import { getAllowedEdgeOperation, findAllEdges, findNodeAtOffset, isEdgeStatement, isNodeId, getIdentifierText, isAttrStatement, edgeStatementHasAttributes } from "../checker";

import * as ChangeEdgeOpCommand from "./command/ChangeEdgeOpCommand";
import * as ChangeAllOtherEdgeOpsAndFixGraphCommand from "./command/ChangeAllOtherEdgeOpsAndFixGraphCommand";
import * as ConsolidateDescendantsCommand from "./command/ConsolidateDescendantsCommand";

import { EdgeOpStr, getGraphKeywordStr, getEdgeStr, ExecutableCommand, getOppositeKind, getOppositeEdgeOp, getAllowedOp } from "./command/common";

export function getCodeActions(doc: DocumentLike, sourceFile: SourceFile, range: lst.Range, context: lst.CodeActionContext): lst.Command[] | undefined {
	let actions = getActionsFromDiagnostics(doc, sourceFile, range);
	const general = getGeneralRefactorings(doc, sourceFile, range);
	if (general) {
		if (!actions)
			actions = general;
		else
			actions.push.apply(actions, general);
	}

	return actions;
}

function getActionsFromDiagnostics(doc: DocumentLike, file: SourceFile, range: lst.Range): lst.Command[] | undefined {
	const ds = file.diagnostics;
	if (!ds || ds.length === 0)
		return undefined;

	const rangeStartOffset = doc.offsetAt(range.start);
	const rangeEndOffset = doc.offsetAt(range.end);

	const res: lst.Command[] = [];
	for (const d of ds) {
		if (isInRange(rangeStartOffset, rangeEndOffset, d.start, d.end)) {
			// The code action request was for the error message range
			const commands = getCommandsForDiagnostic(doc, file, d);
			if (commands && commands.length > 0)
				res.push.apply(res, commands);
		}
	}
	return res.length === 0 ? undefined : res;
}

function getGeneralRefactorings(doc: DocumentLike, file: SourceFile, range: lst.Range): lst.Command[] | undefined {
	if (!file.graph)
		return undefined;

	const g = file.graph;
	const kw = g.keyword;

	const rangeStartOffset = doc.offsetAt(range.start);
	const rangeEndOffset = doc.offsetAt(range.end);

	const keywordStart = getStart(file, kw);

	// Check if the user clicked on "graph" or "digraph" so we can offer graph conversion

	const res = [];

	if (isInRange(rangeStartOffset, rangeEndOffset, keywordStart, kw.end)) {
		// Only offer graph refactoring if the graph has no errors
		if (!subtreeContainsErrors(g)) {
			const oppositeGraphType = getOppositeKind(kw.kind);
			const convertGraph = convertGraphTypeCommand(file, g, oppositeGraphType);
			res.push(convertGraph);
		}
	}

	if (rangeStartOffset === rangeEndOffset) {

		const candidates: EdgeStatement[] = [];

		let clickedNode = findNodeAtOffset(g, rangeStartOffset);
		if (clickedNode && !!clickedNode.parent) {
			if (isIdentifierNode(clickedNode)) {
				clickedNode = clickedNode.parent as SyntaxNode;
			}
			const clickedEdgeStatement = clickedNode.parent;
			if (clickedEdgeStatement && !subtreeContainsErrors(clickedEdgeStatement)) {
				if (isEdgeStatement(clickedEdgeStatement)
					&& clickedEdgeStatement.rhs.length === 1
					&& isNodeId(clickedEdgeStatement.source)
					&& !edgeStatementHasAttributes(clickedEdgeStatement) /* We only support edge statements that have no attributes */
				) {
					candidates.push(clickedEdgeStatement);

					// TODO: May use "getEdges"?

					const source = clickedEdgeStatement.source;
					const sourceText = getIdentifierText(source.id);

					const graphParent = clickedEdgeStatement.parent;
					if (graphParent) {
						let hasVisitedStatement = false;
						let hasVisitedNodeModifier = false;
						forEachChild(graphParent, statement => {
							if (statement === clickedEdgeStatement) {
								hasVisitedStatement = true;
								return undefined;
							}

							if (hasVisitedNodeModifier) {
								return;
							} else if (
								isAttrStatement(statement)
								|| subtreeContainsErrors(statement) // We treat errors in the following statements as semantic changes
							) {
								// TODO: We may make this less strict, allowing graph modofications or something

								// We have visited a statement that changes the behaviour of the following notes
								// We dont want to proceed here
								hasVisitedNodeModifier = true;
								return true;
							}

							if (hasVisitedStatement) {
								if (isEdgeStatement(statement)
									&& statement.rhs.length === 1
									&& !edgeStatementHasAttributes(statement) /* We only support edge statements that have no attributes */
								) {
									const statementSource = statement.source;
									if (isNodeId(statementSource)) {
										const lowerSourceText = getIdentifierText(statementSource.id);
										if (sourceText === lowerSourceText) {
											candidates.push(statement);
										}
									}
								}
							}
							return undefined;
						});
					}
				}

				if (candidates.length > 1) {
					const action = ConsolidateDescendantsCommand.create(candidates, true);
					res.push(action);
				}
			}
		}
	}

	return res.length === 0 ? undefined : res;;
}


function getCommandsForDiagnostic(doc: DocumentLike, file: SourceFile, d: DiagnosticMessage): lst.Command[] | undefined {
	switch (d.code.source) {
		case ErrorSource.Scan: return getScannerErrorCommand(doc, file, d, d.code);
		case ErrorSource.Parse: return getParserErrorCommand(doc, file, d, d.code);
		case ErrorSource.Check: return getCheckerErrorCommand(doc, file, d, d.code);
		default: return assertNever(d.code);
	}
}
function getScannerErrorCommand(doc: DocumentLike, file: SourceFile, d: DiagnosticMessage, code: ScanErrorCode): lst.Command[] | undefined {
	console.assert(d.code.source === ErrorSource.Scan);
	console.assert(code.source === ErrorSource.Scan);
	return undefined; // TODO
}

function getParserErrorCommand(doc: DocumentLike, file: SourceFile, d: DiagnosticMessage, code: ParseErrorCode): lst.Command[] | undefined {
	console.assert(d.code.source === ErrorSource.Parse);
	console.assert(code.source === ErrorSource.Parse);
	return undefined; // TODO
}

function getCheckerErrorCommand(doc: DocumentLike, file: SourceFile, d: DiagnosticMessage, code: CheckErrorCode): lst.Command[] | undefined {
	console.assert(d.code.source === ErrorSource.Check);
	console.assert(code.source === ErrorSource.Check);
	switch (code.sub) {
		case CheckError.InvalidEdgeOperation: {
			const graph = file.graph;
			if (!graph)
				return undefined;

			const allowedOp = getAllowedEdgeOperation(graph);
			const wrongOp = getOppositeEdgeOp(allowedOp);

			const kwk = graph.keyword.kind;

			const fixSingleEdge = ChangeEdgeOpCommand.create(d.start, d.end, allowedOp, wrongOp);
			const fixAll = convertGraphTypeCommand(file, graph, kwk);
			const convertToThisWrongType = convertGraphTypeCommand(file, graph, getOppositeKind(kwk));
			return [
				fixSingleEdge,
				fixAll,
				convertToThisWrongType,
			];
		}
	}
}

function convertGraphTypeCommand(file: SourceFile, graph: Graph, changeToGraphType: SyntaxKind.DigraphKeyword | SyntaxKind.GraphKeyword) {
	const changeToEdgeOp = getAllowedOp(changeToGraphType);

	const allEdges = findAllEdges(graph);
	const edgeOffsets = allEdges
		.filter(e => e.operation.kind !== changeToEdgeOp)
		.map(e => ({
			start: getStart(file, e.operation),
			end: e.operation.end
		}));

	const graphTypeOffset = {
		start: getStart(file, graph.keyword),
		end: graph.keyword.end
	};

	return ChangeAllOtherEdgeOpsAndFixGraphCommand.create(
		edgeOffsets,
		changeToEdgeOp,
		graphTypeOffset,
		graph.keyword.kind,
		changeToGraphType
	);
}

function isInRange(rangeStartOffset: number, rangeEndOffset: number, startOffset: number, endOffset: number): boolean {
	if (rangeStartOffset === rangeEndOffset)
		return startOffset <= rangeStartOffset && rangeEndOffset <= endOffset;
	if (rangeStartOffset === startOffset && rangeEndOffset === endOffset)
		return true;
	return false; // TODO
}

type CommandID = string;
export const enum CommandIds {
	ChangeEdgeOp = "DOT.changeEdgeOp",
	ConvertGraphType = "DOT.convertGraphType",
	ConsolidateDescendants = "DOT.consolidateDescendants",
}

type CommandHandler = (doc: DocumentLike, sourceFile: SourceFile, cmd: ExecutableCommand) => CommandApplication | undefined;

interface CommandHandlers {
	[i: string]: CommandHandler
}

const commandHandlers: CommandHandlers = {
	[CommandIds.ChangeEdgeOp]: ChangeEdgeOpCommand.execute,
	[CommandIds.ConvertGraphType]: ChangeAllOtherEdgeOpsAndFixGraphCommand.execute,
	[CommandIds.ConsolidateDescendants]: ConsolidateDescendantsCommand.execute,
};

export function getAvailableCommands() {
	return Object.keys(commandHandlers);
}

export function executeCommand(doc: DocumentLike, sourceFile: SourceFile, cmd: ExecutableCommand): CommandApplication | undefined {
	const handler = commandHandlers[cmd.command];
	return handler === undefined
		? undefined
		: handler(doc, sourceFile, cmd);
}


function subtreeContainsErrors(node: SyntaxNode): boolean {
	if (hasNodeError(node))
		return true;

	let hasError = false;
	forEachChild(node, child => {
		if (hasNodeError(child)) {
			hasError = true;
		}
		if (!hasError) {
			hasError = subtreeContainsErrors(child);
		}
	});
	return hasError;
}

function hasNodeError(node: SyntaxNode): boolean {
	return (node.flags & SyntaxNodeFlags.ContainsErrors) === SyntaxNodeFlags.ContainsErrors
}
