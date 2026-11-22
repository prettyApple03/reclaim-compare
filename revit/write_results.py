# -*- coding: utf-8 -*-
# pyRevit에서 결과를 부재에 기록하고 해체 경제성 비교 시트를 만든다.
# Revit 밖에서는 CSV·JSON 및 시트 문구의 셀프체크를 실행한다.
#
# 준비: 같은 폴더의 ReClaim_SharedParams.txt 를 쓴다 (스크립트가 자동으로 연결한다).
# 처음 쓸 때는 모델 사본에서 실행해 본다.
import io
import json
import os
from collections import Counter
from math import ceil
from uuid import uuid4

TEXT = ("RC_Waste", "RC_Method")
NUMBER = ("RC_Tons", "RC_DisposalCost", "RC_Revenue")
RUN_PARAMETER = "RC_ResultRun"
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


def summary_text(s):
    """요약 JSON → 프로젝트 정보에 넣을 한 줄."""
    return u"압쇄 {:,}원 / 분별 {:,}원 / 차이 {:,}원 / 분별이 더 쌀 확률 {:.1%} / 권장 {}".format(
        s["crush_total_won"], s["selective_total_won"], s["delta_won"], s["p_selective_cheaper"],
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
        u"분별해체가 더 저렴할 확률    {:.1%}".format(s["p_selective_cheaper"]),
        u"비교 결과    {}".format(recommended_method(s)),
        u"",
        u"부재 결과: {}개 기록 / {}개 매칭 또는 기록 실패".format(done, missing),
        u"아래 집계는 매칭된 부재의 전면 분별 기준입니다.",
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
            ("RC_Waste", u"폐기물 성상", 0.23), ("RC_Method", u"부재 처리", 0.17),
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
        if field.ParameterId in (parameters["RC_DisposalCost"], parameters["RC_Revenue"]):
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


def make_comparison_sheet(DB, doc, data, parameters, run_id, done, missing):
    sheet = next((v for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)
                  if v.SheetNumber == SHEET_NUMBER and v.Name == SHEET_NAME), None)
    if sheet is None:
        used_numbers = {v.SheetNumber for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)}
        sheet = next((v for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)
                      if v.Name == SHEET_NAME and v.SheetNumber.startswith(SHEET_NUMBER + "-")), None)
        if sheet is None:
            sheet = DB.ViewSheet.Create(doc, DB.ElementId.InvalidElementId)
            number = SHEET_NUMBER
            suffix = 2
            while number in used_numbers:
                number = "{}-{}".format(SHEET_NUMBER, suffix)
                suffix += 1
            sheet.SheetNumber = number
            sheet.Name = SHEET_NAME

    schedule = make_schedule(DB, doc, SCHEDULE_NAME, parameters, run_id, grouped=True)
    make_schedule(DB, doc, DETAIL_NAME, parameters, run_id, grouped=False)
    placed = DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.ScheduleSheetInstance)
    if not any(instance.ScheduleId == schedule.Id for instance in placed):
        DB.ScheduleSheetInstance.Create(doc, sheet.Id, schedule.Id, DB.XYZ(0.09, 0.52, 0))

    note_text = sheet_text(data, done, missing)
    notes = DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.TextNote)
    note = next((n for n in notes if n.Text.startswith(SHEET_NAME)), None)
    if note is None:
        text_type = doc.GetDefaultElementTypeId(DB.ElementTypeGroup.TextNoteType)
        options = DB.TextNoteOptions(text_type)
        width = min(DB.TextElement.GetMaximumAllowedWidth(doc, text_type),
                    max(0.70, DB.TextElement.GetMinimumAllowedWidth(doc, text_type)))
        note = DB.TextNote.Create(doc, sheet.Id, DB.XYZ(0.09, 0.89, 0), width, note_text, options)
    else:
        note.Text = note_text

    # Exports before the style field was added also use the readable layout.
    if data.get("revit_sheet_style", "readable-v1") == "readable-v1":
        style_name = "ReClaim Summary 3.5mm"
        style = next((t for t in DB.FilteredElementCollector(doc).OfClass(DB.TextNoteType)
                      if DB.Element.Name.GetValue(t) == style_name), None)
        if style is None:
            style = doc.GetElement(note.GetTypeId()).Duplicate(style_name)
            style.get_Parameter(DB.BuiltInParameter.TEXT_SIZE).Set(3.5 / 304.8)
        note.ChangeTypeId(style.Id)
    lines = note_text.splitlines()
    note.Text = u"\r".join(lines)
    formatted = note.GetFormattedText()
    formatted.SetBoldStatus(DB.TextRange(0, len(lines[0])), True)
    for label in (u"압쇄해체 순비용", u"분별해체 순비용", u"순비용 차이"):
        content = formatted.GetPlainText()
        start = content.find(label)
        if start >= 0:
            end = content.find(u"\r", start)
            formatted.SetBoldStatus(DB.TextRange(start, (end if end >= 0 else len(content)) - start), True)
    note.SetFormattedText(formatted)
    note.Width = 0.75
    note.Coord = DB.XYZ(0.09, 0.99, 0)
    subtitle = u"두 공법의 순비용 비교"
    title = next((n for n in DB.FilteredElementCollector(doc, sheet.Id).OfClass(DB.TextNote)
                  if n.Text.strip() == subtitle), None)
    if title is None:
        default_type = doc.GetDefaultElementTypeId(DB.ElementTypeGroup.TextNoteType)
        style_name = u"ReClaim 비교 제목 5mm"
        style = next((t for t in DB.FilteredElementCollector(doc).OfClass(DB.TextNoteType)
                      if DB.Element.Name.GetValue(t) == style_name), None)
        if style is None:
            style = doc.GetElement(default_type).Duplicate(style_name)
            style.get_Parameter(DB.BuiltInParameter.TEXT_SIZE).Set(5.0 / 304.8)
            style.get_Parameter(DB.BuiltInParameter.TEXT_STYLE_BOLD).Set(1)
        DB.TextNote.Create(doc, sheet.Id, DB.XYZ(0.09, 1.04, 0), subtitle, style.Id)

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
    if viewport is None:
        if not DB.Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id):
            raise ValueError(u"해체 대상 3D 뷰가 다른 시트에 배치되어 있습니다.")
        center = DB.XYZ(1.04, 0.72, 0)
        viewport = DB.Viewport.Create(doc, sheet.Id, view.Id, center)
    else:
        center = viewport.GetBoxCenter()
    doc.Regenerate()
    outline = viewport.GetBoxOutline()
    size = outline.MaximumPoint - outline.MinimumPoint
    ratio = max(size.X / 0.50, size.Y / 0.29)
    if ratio > 1 or ratio < 0.75:
        view.Scale = max(10, int(ceil(view.Scale * ratio / 10.0)) * 10)
        doc.Regenerate()
        viewport.SetBoxCenter(center)
    return sheet


def run_in_revit():
    from Autodesk.Revit import DB
    from pyrevit import forms, revit, script
    from System import Int64

    doc, app, out = revit.doc, revit.doc.Application, script.get_output()
    csv_path = forms.pick_file(file_ext="csv", title="reclaim_elements.csv 고르기")
    if not csv_path:
        return
    rows = read_rows(csv_path)
    json_path = os.path.join(os.path.dirname(csv_path), "reclaim_summary.json")
    data = None
    if os.path.isfile(json_path):
        data = json.loads(read_export_text(json_path))
        project_summary = summary_text(data)
    elif any(v.Name == SHEET_NAME and v.SheetNumber.startswith(SHEET_NUMBER)
             for v in DB.FilteredElementCollector(doc).OfClass(DB.ViewSheet)):
        raise ValueError(u"기존 비교 시트를 갱신하려면 CSV와 같은 폴더에 reclaim_summary.json을 두세요.")
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
            keys = TEXT + NUMBER + ((RUN_PARAMETER,) if data is not None else ())
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
                if any(p is None or p.IsReadOnly for p in params.values()):
                    failures[(u"기록 가능한 매개변수 없음", el.Category.Name if el.Category else r["Category"])] += 1
                    continue
                for k in keys:
                    params[k].Set(run_id if k == RUN_PARAMETER else r[k])
                done += 1

            missing = sum(failures.values())
            if data is not None:
                if not done:
                    raise ValueError(u"현재 모델과 일치하는 부재가 없습니다. 이 모델에서 내보낸 IFC의 CSV를 선택하세요.")
                doc.ProjectInformation.get_Parameter(definitions["RC_Summary"].GUID).Set(project_summary)
                parameter_ids = {k: DB.SharedParameterElement.Lookup(doc, definitions[k].GUID).Id for k in keys}
                sheet = make_comparison_sheet(DB, doc, data, parameter_ids, run_id, done, missing)
    finally:
        app.SharedParametersFilename = old
    out.print_md(u"**{}개 부재에 기록했습니다.** 매칭 또는 기록 실패: {}개".format(done, missing))
    for (reason, category), count in sorted(failures.items()):
        out.print_md(u"- {} · {}: {}개".format(reason, category, count))
    if sheet is not None:
        out.print_md(u"**시트 {} — {}** · 프로젝트 탐색기의 시트에서 확인하세요.".format(sheet.SheetNumber, sheet.Name))
        revit.uidoc.RequestViewChange(sheet)
    else:
        out.print_md(u"비교 시트 생성에는 CSV와 같은 폴더의 `reclaim_summary.json`이 필요합니다.")


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
