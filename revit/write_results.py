# -*- coding: utf-8 -*-
# pyRevit에서 결과를 부재에 기록하고 해체 경제성 비교 시트를 만든다.
# Revit 밖에서는 CSV·JSON 및 시트 문구의 셀프체크를 실행한다.
#
# 준비: 같은 폴더의 ReClaim_SharedParams.txt 를 쓴다 (스크립트가 자동으로 연결한다).
# 처음 쓸 때는 모델 사본에서 실행해 본다.
import io
import json
import os
import base64
import tempfile
from collections import Counter
from math import ceil, isinf, isnan
from uuid import uuid4

TEXT = ("RC_Waste", "RC_Method")
NUMBER = ("RC_Tons", "RC_DisposalCost", "RC_Revenue")
RUN_PARAMETER = "RC_ResultRun"
CRUSH_METHOD = "RC_CrushMethod"
CRUSH_DISPOSAL = "RC_CrushDisposalCost"
CRUSH_REVENUE = "RC_CrushRevenue"
SHEET_NUMBER = "RC-01"
SHEET_NAME = u"해체 경제성 비교"
VIEW_NAME = u"ReClaim - 해체 대상 3D"
SCHEDULE_NAME = u"ReClaim - 폐기물 성상별 집계 (전면 분별)"
DETAIL_NAME = u"ReClaim - 부재별 해체 결과 (전면 분별)"


def read_export_text(path):
    try:
        from System.IO import File
    except ImportError:
        with io.open(path, "r", encoding="utf-8-sig") as export:
            return export.read()
    # IronPython's io decoder can split a UTF-8 character across buffers.
    # Revit's .NET reader handles UTF-8, with or without a BOM.
    return File.ReadAllText(path)


def read_rows(path):
    """CSV → [{ElementId, RC_Waste, ...}]. 따옴표 없는 단순 CSV, BOM 허용."""
    lines = [line.strip() for line in read_export_text(path).splitlines() if line.strip()]
    head = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        r = dict(zip(head, line.split(",")))
        for k in NUMBER:
            r[k] = float(r[k])
        rows.append(r)
    return rows


try:
    TEXT_TYPE = basestring  # IronPython 2: JSON strings may be str or unicode.
except NameError:
    TEXT_TYPE = str


def read_revit_export(path):
    payload = json.loads(read_export_text(path))
    if not isinstance(payload, dict) or payload.get("schema") != "reclaim-revit-v1":
        raise ValueError("Invalid ReClaim export schema")
    summary, rows = payload["summary"], payload["elements"]
    if not isinstance(rows, list) or not rows or not summary["source"]:
        raise ValueError("Missing ReClaim model or element results")
    for row in rows:
        if not all(isinstance(row[key], TEXT_TYPE) for key in ("ElementId", "Category") + TEXT):
            raise ValueError("Invalid ReClaim element fields")
        for key in NUMBER:
            value = float(row[key])
            if isinf(value) or isnan(value):
                raise ValueError("Invalid ReClaim numeric value")
            row[key] = value
    summary = dict(summary, scenario_costs=payload.get("scenario_costs", {}),
                   cost_chart_png=payload.get("cost_chart_png"))
    return summary, rows


def summary_text(s):
    """요약 JSON → 프로젝트 정보에 넣을 한 줄."""
    return u"압쇄 {:,}원 / 분별 {:,}원 / 차이 {:,}원 / 분별이 더 쌀 확률 {:.1%} / 권장 {}".format(
        s["crush_total_won"], s["selective_total_won"], s["delta_won"], float(s["p_selective_cheaper"]),
        recommended_method(s))


def recommended_method(s):
    return {"selective": u"분별해체", "crush": u"압쇄해체", "tie": u"동일"}.get(s["recommended"], u"판정 보류")


def sheet_text(s, done, missing):
    area = s.get("area_m2")
    area_text = u"{:,.1f} ㎡".format(area) if area else u"미입력"
    scope = (u"\n미산정 항목이 있습니다." if
             s.get("unpriced_concrete_cut") or any((s.get("unpriced_disposal") or {}).values()) else u"")
    return u"\n".join((
        SHEET_NAME,
        u"대상: {} / 연면적: {}".format(s.get("source") or u"IFC 모델", area_text),
        u"",
        u"압쇄해체 순비용    {:,} 원".format(s["crush_total_won"]),
        u"분별해체 순비용    {:,} 원".format(s["selective_total_won"]),
        u"순비용 차이(분별 − 압쇄)    {:+,} 원".format(s["delta_won"]),
        u"분별해체가 더 저렴할 확률    {:.1%}".format(float(s["p_selective_cheaper"])),
        u"비교 결과    {}".format(recommended_method(s)),
        u"",
        u"부재 결과: {}개 기록 / {}개 매칭 또는 기록 실패".format(done, missing),
        u"부재별 결과는 RC-02 전면 분별과 RC-03 일괄 압쇄 시트에서 확인할 수 있습니다.",
        u"건물 전체 순비용에는 인건비·장비비 등 공통 비용도 반영됩니다. 형상에 대응하지 않는 보정량은 부재 집계에서 제외합니다." + scope,
    ))


def make_schedule(DB, doc, name, parameters, run_id, grouped):
    view = next((v for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSchedule)
                 if v.Name == name and not v.IsTemplate), None)
    if view is None:
        view = DB.ViewSchedule.CreateSchedule(doc, DB.ElementId.InvalidElementId)
        view.Name = name
    definition = view.Definition
    # Repair schedules created with the shared fields interpreted as Project Information.
    instance_ids = {definition.GetField(fid).ParameterId for fid in definition.GetFieldOrder()
                    if definition.GetField(fid).FieldType == DB.ScheduleFieldType.Instance}
    if not set(parameters.values()).issubset(instance_ids):
        definition.ClearFields()
        fields = {field.ParameterId: field for field in definition.GetSchedulableFields()
                  if field.FieldType == DB.ScheduleFieldType.Instance}
        columns = (
            ("RC_Waste", u"폐기물 성상", 0.23), ("RC_Method", u"부재 처리 방식", 0.17),
            ("RC_Tons", u"중량(t)", 0.19), ("RC_DisposalCost", u"처리비(원)", 0.24),
            ("RC_Revenue", u"매각수익(원)", 0.24), (RUN_PARAMETER, u"결과 ID", 0.16),
        )
        if not grouped:
            for key, heading, width in ((DB.BuiltInParameter.ELEM_CATEGORY_PARAM, u"범주", 0.23),
                                        (DB.BuiltInParameter.ELEM_FAMILY_AND_TYPE_PARAM, u"패밀리 및 유형", 0.38)):
                sid = DB.ElementId(key)
                if sid in fields:
                    field = definition.AddField(fields[sid])
                    field.ColumnHeading = heading
                    field.SheetColumnWidth = width
            definition.IsItemized = True
        else:
            definition.IsItemized = False
            definition.ShowGrandTotal = True
            definition.ShowGrandTotalCount = False
            definition.ShowGrandTotalTitle = True
            definition.GrandTotalTitle = u"합계"
        for key, heading, width in columns:
            if key not in parameters:
                continue
            field = definition.AddField(fields[parameters[key]])
            field.ColumnHeading = heading
            field.SheetColumnWidth = width
            field.IsHidden = key == RUN_PARAMETER
            if key in TEXT:
                definition.AddSortGroupField(DB.ScheduleSortGroupField(field.FieldId))
            if grouped and key in NUMBER:
                field.DisplayType = DB.ScheduleFieldDisplayType.Totals

    for fid in definition.GetFieldOrder():
        field = definition.GetField(fid)
        if field.ParameterId in (parameters.get("RC_DisposalCost"), parameters.get("RC_Revenue")):
            fmt = DB.FormatOptions(DB.UnitTypeId.Fixed)
            fmt.Accuracy = 1
            fmt.UseDigitGrouping = True
            field.SetFormatOptions(fmt)
            field.HorizontalAlignment = DB.ScheduleHorizontalAlignment.Right
        elif field.ParameterId == parameters["RC_Tons"]:
            field.HorizontalAlignment = DB.ScheduleHorizontalAlignment.Right
    run_field = next(definition.GetField(fid) for fid in definition.GetFieldOrder()
                     if definition.GetField(fid).ParameterId == parameters[RUN_PARAMETER])
    run_filter = DB.ScheduleFilter(run_field.FieldId, DB.ScheduleFilterType.Equal, run_id)
    index = next((idx for idx, flt in enumerate(definition.GetFilters())
                  if flt.FieldId == run_field.FieldId), None)
    if index is None:
        definition.AddFilter(run_filter)
    else:
        definition.SetFilter(index, run_filter)
    return view


def get_reclaim_sheet(DB, doc, number_prefix, name, legacy_name=None):
    sheet = next((v for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)
                  if v.SheetNumber == number_prefix and v.Name in (name, legacy_name)), None)
    if sheet is None:
        used_numbers = {v.SheetNumber for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)}
        sheet = next((v for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)
                      if v.Name in (name, legacy_name) and v.SheetNumber.startswith(number_prefix + "-")), None)
        if sheet is None:
            sheet = DB.ViewSheet.Create(doc, DB.ElementId.InvalidElementId)
            number = number_prefix
            suffix = 2
            while number in used_numbers:
                number = "{}-{}".format(number_prefix, suffix)
                suffix += 1
            sheet.SheetNumber = number
    sheet.Name = name

    return sheet


def place_schedule(DB, doc, sheet, schedule):
    placed = DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.ScheduleSheetInstance)
    instance = next((item for item in placed if item.ScheduleId == schedule.Id), None)
    return instance or DB.ScheduleSheetInstance.Create(doc, sheet.Id, schedule.Id, DB.XYZ(0.09, 0.99, 0))


def make_method_sheet(DB, doc, number, name, schedule, data, costs):
    sheet = get_reclaim_sheet(DB, doc, number, name)
    instance = place_schedule(DB, doc, sheet, schedule)
    text = u"대상 IFC: {}".format(data["source"])
    if costs:
        text += u"\n건물 전체 처리비 {:,}원 / 매각수익 {:,}원".format(
            costs["disposal"], costs["revenue"])
    if number == "RC-02":
        text += u"\n전면 분별 시나리오에서도 콘크리트 구조체 등은 압쇄 처리할 수 있습니다."
    if number == "RC-03":
        text += u"\n처리비·매각수익은 건물 전체 집계로 표시합니다."
    title = name + u"\n"
    notes = DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.TextNote)
    note = next((n for n in notes if n.Text.startswith(name)), None)
    if note is None:
        style = doc.GetDefaultElementTypeId(DB.ElementTypeGroup.TextNoteType)
        DB.TextNote.Create(doc, sheet.Id, DB.XYZ(0.09, 1.16, 0), title + text, style)
    else:
        note.Text = title + text
    doc.Regenerate()
    box = instance.get_BoundingBox(sheet)
    footer_point = DB.XYZ(instance.Point.X, (box.Min.Y if box else instance.Point.Y) - 0.04, 0)
    footer_label = u"최종 합계 (건물 전체 순비용)"
    net = data["selective_total_won" if number == "RC-02" else "crush_total_won"]
    footer_text = u"{}    {:,} 원".format(footer_label, net)
    footer = next((n for n in DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.TextNote)
                   if n.Text.startswith(footer_label)), None)
    if footer is None:
        style = doc.GetDefaultElementTypeId(DB.ElementTypeGroup.TextNoteType)
        footer = DB.TextNote.Create(doc, sheet.Id, footer_point, footer_text, style)
    else:
        footer.Text = footer_text
        footer.Coord = footer_point
    formatted = footer.GetFormattedText()
    formatted.SetBoldStatus(DB.TextRange(0, len(footer_text)), True)
    footer.SetFormattedText(formatted)
    draw_sheet_border(DB, doc, sheet)
    return sheet


def place_cost_chart(DB, doc, sheet, payload):
    if not payload:
        return
    if len(payload) > 3000000:
        raise ValueError("ReClaim chart is too large")
    png = base64.b64decode(payload)
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("ReClaim chart must be PNG")
    prefix = "ReClaim_CostChart_"
    previous = [im.Id for im in DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.ImageInstance)
                if doc.GetElement(im.GetTypeId()).Name.startswith(prefix)]
    path = os.path.join(tempfile.gettempdir(), prefix + uuid4().hex + ".png")
    try:
        with open(path, "wb") as output:
            output.write(png)
        options = DB.ImageTypeOptions(path, False, DB.ImageTypeSource.Import)
        image_type = DB.ImageType.Create(doc, options)
        position = DB.ImagePlacementOptions(DB.XYZ(1.00, 0.365, 0), DB.BoxPlacement.Center)
        image = DB.ImageInstance.Create(doc, sheet, image_type.Id, position)
        image.LockProportions = True
        image.Width = 1.72
        for old_id in previous:
            doc.Delete(old_id)
    finally:
        if os.path.isfile(path):
            os.remove(path)


def draw_sheet_border(DB, doc, sheet):
    name = "ReClaim Sheet Border"
    lines = doc.Settings.Categories.get_Item(DB.BuiltInCategory.OST_Lines)
    category = next((item for item in lines.SubCategories if item.Name == name), None)
    if category is None:
        category = doc.Settings.Categories.NewSubcategory(lines, name)
        category.SetLineWeight(4, DB.GraphicsStyleType.Projection)
    style = category.GetGraphicsStyle(DB.GraphicsStyleType.Projection)
    curves = DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.CurveElement)
    old_ids = [curve.Id for curve in curves
               if curve.LineStyle is not None and curve.LineStyle.Id == style.Id]
    for element_id in old_ids:
        doc.Delete(element_id)

    doc.Regenerate()
    boxes = []
    for element_type in (DB.TextNote, DB.Viewport, DB.ImageInstance, DB.ScheduleSheetInstance, DB.CurveElement):
        for element in DB.FilteredElementCollector(doc, sheet.Id).OfClass(element_type):
            if element.OwnerViewId != sheet.Id:
                continue
            box = element.get_BoundingBox(sheet)
            if box is not None:
                boxes.append(box)
    if not boxes:
        return
    margin = 0.075
    left = min(box.Min.X for box in boxes) - margin
    right = max(box.Max.X for box in boxes) + margin
    bottom = min(box.Min.Y for box in boxes) - margin
    top = max(box.Max.Y for box in boxes) + margin
    corners = [(left, bottom), (right, bottom), (right, top), (left, top)]
    for (x1, y1), (x2, y2) in zip(corners, corners[1:] + corners[:1]):
        line = DB.Line.CreateBound(DB.XYZ(x1, y1, 0), DB.XYZ(x2, y2, 0))
        doc.Create.NewDetailCurve(sheet, line).LineStyle = style


def draw_comparison_layout(DB, doc, sheet, data, done, missing):
    prefix = "ReClaim RC01 "
    line_name = prefix + "rules"
    lines = doc.Settings.Categories.get_Item(DB.BuiltInCategory.OST_Lines)
    category = next((item for item in lines.SubCategories if item.Name == line_name), None)
    if category is None:
        category = doc.Settings.Categories.NewSubcategory(lines, line_name)
        category.LineColor = DB.Color(110, 132, 155)
    line_style = category.GetGraphicsStyle(DB.GraphicsStyleType.Projection)
    old_notes = [note.Id for note in DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.TextNote)
                 if DB.Element.Name.GetValue(doc.GetElement(note.GetTypeId())).startswith(prefix)
                 or note.Text.startswith(SHEET_NAME + u"\r")
                 or note.Text.startswith(SHEET_NAME + u"\n")
                 or note.Text.strip() == u"두 공법의 순비용 비교"]
    old_rules = [curve.Id for curve in DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.CurveElement)
                 if curve.LineStyle is not None and curve.LineStyle.Id == line_style.Id]
    for element_id in old_notes + old_rules:
        doc.Delete(element_id)

    styles = {}
    for role, size, bold in (("Title", 8, True), ("Heading", 6, True), ("Body", 4.5, False),
                             ("Table", 6, False), ("Amount", 7, True)):
        name = prefix + role
        style = next((item for item in DB.FilteredElementCollector(doc).OfClass(DB.TextNoteType)
                      if DB.Element.Name.GetValue(item) == name), None)
        if style is None:
            default_id = doc.GetDefaultElementTypeId(DB.ElementTypeGroup.TextNoteType)
            style = doc.GetElement(default_id).Duplicate(name)
        style.get_Parameter(DB.BuiltInParameter.TEXT_SIZE).Set(size / 304.8)
        style.get_Parameter(DB.BuiltInParameter.TEXT_STYLE_BOLD).Set(int(bold))
        styles[role] = style.Id

    def rule(x1, y1, x2, y2):
        line = DB.Line.CreateBound(DB.XYZ(x1, y1, 0), DB.XYZ(x2, y2, 0))
        doc.Create.NewDetailCurve(sheet, line).LineStyle = line_style

    def frame(left, right, top, bottom, heading):
        rule(left, top, right, top)
        rule(left, bottom, right, bottom)
        rule(left, bottom, left, top)
        rule(right, bottom, right, top)
        rule(left, top - 0.09, right, top - 0.09)
        text(left + 0.035, top - 0.018, heading, "Heading")

    def text(x, y, value, role="Body", right=False):
        options = DB.TextNoteOptions(styles[role])
        if right:
            options.HorizontalAlignment = DB.HorizontalTextAlignment.Right
        DB.TextNote.Create(doc, sheet.Id, DB.XYZ(x, y, 0), value, options)

    text(0.10, 1.72, u"RC-01  해체 공법 경제성 비교", "Title")
    area = data.get("area_m2")
    area_text = u"{:,.1f} m\u00b2".format(float(area)) if area else u"미입력"
    text(0.10, 1.59, u"{}  ·  연면적 {}".format(data.get("source") or u"IFC 모델", area_text))
    frame(0.10, 1.10, 1.48, 0.73, u"순비용 비교")
    frame(1.15, 1.90, 1.48, 0.73, u"해체 대상 3D")
    frame(0.10, 1.90, 0.68, 0.13, u"공법별 비용 구성")

    rows = (
        (u"항목", u"결과"),
        (u"일괄 압쇄", u"{:,}원".format(data["crush_total_won"])),
        (u"전면 분별", u"{:,}원".format(data["selective_total_won"])),
        (u"차액 (분별 − 압쇄)", u"{:+,}원".format(data["delta_won"])),
        (u"분별이 더 저렴할 확률", u"{:.1%}".format(float(data["p_selective_cheaper"]))),
        (u"비교 결과", recommended_method(data)),
    )
    for index, (label, value) in enumerate(rows):
        y = 1.39 - index * 0.087
        role = "Heading" if index in (0, 5) else "Table"
        value_role = "Amount" if index in (1, 2, 3) else role
        text(0.135, y - 0.022, label, role)
        text(1.065, y - 0.022, value, value_role, right=True)
        rule(0.10, y - 0.087, 1.10, y - 0.087)
    rule(0.65, 1.39, 0.65, 1.39 - len(rows) * 0.087)
    text(0.135, 0.842, u"부재 {}개 기록 · 매칭 또는 기록 실패 {}개".format(done, missing))
    text(0.135, 0.788, u"부재별 결과는 RC-02 및 RC-03 참조")
    if data.get("unpriced_concrete_cut") or any((data.get("unpriced_disposal") or {}).values()):
        text(0.10, 0.105, u"일부 항목은 미산정 상태입니다.")
    if not data.get("cost_chart_png"):
        text(0.135, 0.53, u"비용 그래프는 사이트에서 새로 받은 Revit용 결과에 포함됩니다.")


def make_comparison_sheet(DB, doc, data, parameters, run_id, done, missing):
    sheet = get_reclaim_sheet(DB, doc, SHEET_NUMBER, u"경제성 비교 · 일괄 압쇄 vs 전면 분별", SHEET_NAME)
    for instance in DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.ScheduleSheetInstance).ToElements():
        if doc.GetElement(instance.ScheduleId).Name == SCHEDULE_NAME:
            doc.Delete(instance.Id)

    draw_comparison_layout(DB, doc, sheet, data, done, missing)

    view = next((v for v in DB.FilteredElementCollector(doc).OfClass(DB.View3D)
                 if v.Name == VIEW_NAME and not v.IsTemplate), None)
    if view is None:
        view_type = next(t for t in DB.FilteredElementCollector(doc).OfClass(DB.ViewFamilyType)
                         if t.ViewFamily == DB.ViewFamily.ThreeDimensional)
        view = DB.View3D.CreateIsometric(doc, view_type.Id)
        view.Name = VIEW_NAME
    level_category = DB.ElementId(DB.BuiltInCategory.OST_Levels)
    if view.CanCategoryBeHidden(level_category):
        view.SetCategoryHidden(level_category, True)
    view.DisplayStyle = DB.DisplayStyle.ShadingWithEdges
    viewport = next((doc.GetElement(vid) for vid in sheet.GetAllViewports()
                     if doc.GetElement(vid).ViewId == view.Id), None)
    center = DB.XYZ(1.525, 1.035, 0)
    if viewport is None:
        if not DB.Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id):
            raise ValueError(u"해체 대상 3D 뷰가 다른 시트에 배치되어 있습니다.")
        viewport = DB.Viewport.Create(doc, sheet.Id, view.Id, center)
    type_name = "ReClaim RC01 viewport"
    current = doc.GetElement(viewport.GetTypeId())
    viewport_type = next((doc.GetElement(tid) for tid in viewport.GetValidTypes()
                          if DB.Element.Name.GetValue(doc.GetElement(tid)) == type_name), None)
    if viewport_type is None:
        viewport_type = current.Duplicate(type_name)
    show_title = viewport_type.get_Parameter(DB.BuiltInParameter.VIEWPORT_ATTR_SHOW_LABEL)
    if show_title is not None and not show_title.IsReadOnly:
        show_title.Set(0)
    if viewport.GetTypeId() != viewport_type.Id:
        viewport.ChangeTypeId(viewport_type.Id)
    doc.Regenerate()
    outline = viewport.GetBoxOutline()
    size = outline.MaximumPoint - outline.MinimumPoint
    ratio = max(size.X / 0.63, size.Y / 0.48)
    if ratio > 1 or ratio < 0.75:
        view.Scale = max(1, int(ceil(view.Scale * ratio)))
        doc.Regenerate()
    viewport.SetBoxCenter(center)
    return sheet


def run_in_revit():
    from Autodesk.Revit import DB
    from pyrevit import forms, revit, script
    from System import Int64

    doc, app, out = revit.doc, revit.doc.Application, script.get_output()
    path = forms.pick_file(file_ext="json", title=u"사이트에서 받은 .reclaim.json 선택")
    if not path:
        return
    try:
        data, rows = read_revit_export(path)
        project_summary = summary_text(data)
    except (IOError, ValueError, KeyError, TypeError, AttributeError, OverflowError) as error:
        forms.alert(u"Revit용 결과를 읽지 못했습니다.\n{}\n\n오류: {}".format(os.path.basename(path), error))
        return
    if not forms.alert(
            u"분석 대상: {}\n열린 Revit 모델: {}\n\n이 모델에 결과를 적용하시겠습니까?".format(
                data["source"], doc.Title), yes=True, no=True):
        return
    run_id = uuid4().hex

    # 공유 매개변수를 모델 범주 전체와 프로젝트 정보에 인스턴스 매개변수로 연결
    here = os.path.dirname(__file__)
    old = app.SharedParametersFilename
    project_info = doc.Settings.Categories.get_Item(DB.BuiltInCategory.OST_ProjectInformation)
    cats = app.Create.NewCategorySet()
    for c in doc.Settings.Categories:
        if c.Id != project_info.Id and c.AllowsBoundParameters and c.CategoryType == DB.CategoryType.Model:
            cats.Insert(c)
    info = app.Create.NewCategorySet()
    info.Insert(project_info)

    sheet = None
    try:
        app.SharedParametersFilename = os.path.join(here, "ReClaim_SharedParams.txt")
        group = app.OpenSharedParameterFile().Groups.get_Item("ReClaim")
        definitions = {d.Name: d for d in group.Definitions}
        with revit.Transaction(u"ReClaim 결과 기록 및 비교 시트 작성"):
            for d in definitions.values():
                existing = DB.SharedParameterElement.Lookup(doc, d.GUID)
                binding = app.Create.NewInstanceBinding(info if d.Name == "RC_Summary" else cats)
                group_id = DB.GroupTypeId.Data if hasattr(DB, "GroupTypeId") else DB.BuiltInParameterGroup.PG_DATA
                if existing is None:
                    inserted = doc.ParameterBindings.Insert(d, binding, group_id)
                else:
                    internal = existing.GetDefinition()
                    current = doc.ParameterBindings.get_Item(internal)
                    if current is None:
                        inserted = doc.ParameterBindings.Insert(d, binding, group_id)
                    elif d.Name != "RC_Summary" and current.Categories.Contains(project_info):
                        inserted = doc.ParameterBindings.ReInsert(internal, binding, group_id)
                    else:
                        continue
                if not inserted:
                    raise ValueError(u"공유 매개변수를 연결하지 못했습니다: {}".format(d.Name))
            doc.Regenerate()

            done = 0
            failures = Counter()
            keys = TEXT + NUMBER + (RUN_PARAMETER,)
            for r in rows:
                if r.get("Category") == "adjustment":
                    continue
                el = None
                if r["ElementId"].isdigit():
                    number = int(r["ElementId"])
                    el = doc.GetElement(DB.ElementId(Int64(number) if int(app.VersionNumber) >= 2024 else number))
                if el is None:
                    failures[(u"모델에 해당 ID 없음", r["Category"])] += 1
                    continue
                params = {k: el.get_Parameter(definitions[k].GUID) for k in keys}
                crush_method = el.get_Parameter(definitions[CRUSH_METHOD].GUID)
                if any(p is None or p.IsReadOnly for p in list(params.values()) + [crush_method]):
                    failures[(u"기록 가능한 매개변수 없음", el.Category.Name if el.Category else r["Category"])] += 1
                    continue
                for k in keys:
                    params[k].Set(run_id if k == RUN_PARAMETER else r[k])
                crush_method.Set(u"제외" if r["RC_Method"] == u"제외" else u"압쇄")
                done += 1

            missing = sum(failures.values())
            if not done:
                raise ValueError(u"현재 모델과 일치하는 부재가 없습니다. 현재 모델과 같은 IFC에서 분석한 ReClaim 결과를 선택하세요.")
            doc.ProjectInformation.get_Parameter(definitions["RC_Summary"].GUID).Set(project_summary)
            parameter_ids = {k: DB.SharedParameterElement.Lookup(doc, definitions[k].GUID).Id for k in keys}
            sheet = make_comparison_sheet(DB, doc, data, parameter_ids, run_id, done, missing)
            place_cost_chart(DB, doc, sheet, data.get("cost_chart_png"))
            draw_sheet_border(DB, doc, sheet)
            selective = make_schedule(DB, doc, DETAIL_NAME, parameter_ids, run_id, grouped=False)
            crush_ids = {key: parameter_ids[key] for key in ("RC_Waste", "RC_Tons", RUN_PARAMETER)}
            for column, key in (("RC_Method", CRUSH_METHOD), ("RC_DisposalCost", CRUSH_DISPOSAL),
                                ("RC_Revenue", CRUSH_REVENUE)):
                crush_ids[column] = DB.SharedParameterElement.Lookup(doc, definitions[key].GUID).Id
            crush = make_schedule(DB, doc, u"ReClaim - 일괄 압쇄 부재별 처리 및 중량",
                                  crush_ids, run_id, grouped=False)
            costs = data.get("scenario_costs", {})
            make_method_sheet(DB, doc, "RC-02", u"전면 분별 · 부재별 해체 결과",
                              selective, data, costs.get("selective"))
            make_method_sheet(DB, doc, "RC-03", u"일괄 압쇄 · 부재별 처리 및 중량",
                              crush, data, costs.get("crush"))
    finally:
        app.SharedParametersFilename = old
    out.print_md(u"**{}개 부재에 기록했습니다.** 매칭 또는 기록 실패: {}개".format(done, missing))
    for (reason, category), count in sorted(failures.items()):
        out.print_md(u"- {} · {}: {}개".format(reason, category, count))
    out.print_md(u"**시트 {} — {}** · 프로젝트 탐색기의 시트에서 확인하세요.".format(sheet.SheetNumber, sheet.Name))
    revit.uidoc.RequestViewChange(sheet)


if __name__ == "__main__":
    try:
        import Autodesk  # noqa: F401  Revit 안에서만 있다
    except ImportError:
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "t.csv")
            with io.open(p, "w", encoding="utf-8-sig") as f:
                f.write(u"GlobalId,ElementId,Category,Floor,RC_Waste,RC_Method,RC_Tons,RC_DisposalCost,RC_Revenue\n"
                        u"0abc,300014,window,1,glass,분별,0.1080,5890,60750\n")
            r = read_rows(p)
            assert len(r) == 1 and r[0]["ElementId"] == "300014" and r[0]["RC_Method"] == u"분별" and r[0]["RC_Tons"] == 0.108
        data = json.loads('{"crush_total_won": 10000, "selective_total_won": 8000, "delta_won": -2000, "p_selective_cheaper": 0.25, "recommended": "selective"}')
        assert u"25.0%" in summary_text(data)
        assert u"-2,000 원" in sheet_text(data, 8, 1)
        assert u"8개 기록 / 1개" in sheet_text(data, 8, 1)
        assert u"판정 보류" in sheet_text(dict(data, recommended=None), 8, 1)
        print("self-check ok: CSV parsing and comparison labels")
    else:
        run_in_revit()
